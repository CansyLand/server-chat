import { spawn } from 'node:child_process';

// ---- Rolling brief for the group-chat overview panel ----------------------
// The first version of this summarised each message on its own, statelessly.
// That was cheap and useless: a message in isolation shows an action with no
// visible reason, so the panel read as disconnected snippets — "reverted the
// hunk", "checked auth.js" — without ever saying what the room was trying to
// achieve or why.
//
// Intent and reasoning only exist *across* messages, so the summarizer has to
// carry state. It does that through the brief itself rather than through a
// session: each call gets the previous brief plus whatever was said since, and
// returns the updated brief. Still a fresh one-shot process every time, still
// no --resume and no growing transcript — input stays bounded at roughly one
// brief plus one burst of messages, however long the discussion runs.

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const BRIEF_MODEL = process.env.BRIEF_MODEL || 'haiku';

const MAX_CONCURRENT = 2;
const MAX_MESSAGE_CHARS = 2500; // per message, before the burst is assembled
const MAX_BURST_CHARS = 12000; // whole batch, so a flurry can't blow the input up
const TIMEOUT_MS = 120000;

const SYSTEM_PROMPT = `You maintain a running brief of a multi-agent group chat for the human operator, who is NOT reading the transcript. They want to know what is being worked on, WHY, and where it stands — never a list of individual messages.

You are given the current brief (possibly empty) and the new messages since it was written. Return the UPDATED brief: carry forward what is still true, revise what changed, drop what is resolved or stale. Never invent anything that isn't supported by the transcript.

The human operator is the only participant who is NOT in the agent member list, so a message addressed to any other name (or to "operator", "human", "the user", or an unqualified "you") is addressed to them.

Write for someone who wants the point immediately. Plain words, no hedging, no "the agents are discussing" throat-clearing — say the substance. Always give the reason behind an action, not just the action.

Return ONLY a JSON object. No markdown fence, no commentary.
{
 "headline": string,
 "why": string,
 "state": string,
 "who": [{"name": string, "doing": string, "why": string}],
 "waitingOnYou": [string],
 "recent": [string]
}

- headline: max 90 chars. What this room is working on right now.
- why: max 200 chars. The problem being solved and why it matters. The intent, not the activity.
- state: max 400 chars. Where things actually stand — what's settled, what's disputed, what's blocked. State disagreements explicitly, naming who takes which side.
- who: one entry per agent that has been active. doing max 80 chars, why max 80 chars. Omit agents that have done nothing.
- waitingOnYou: things needing a decision, answer, or action from the human operator, max 110 chars each. Drop anything they have since answered. Empty array if nothing is blocked on them.
- recent: max 4 items, max 100 chars each, oldest first. Concrete things that just happened.`;

let active = 0;
const pending = [];

function pump() {
  while (active < MAX_CONCURRENT && pending.length) {
    const { task, resolve } = pending.shift();
    active += 1;
    task()
      .then(resolve, () => resolve(null))
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function schedule(task) {
  return new Promise((resolve) => {
    pending.push({ task, resolve });
    pump();
  });
}

function runOneShot(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        '--print',
        '--model', BRIEF_MODEL,
        // Replaces the default system prompt instead of appending to it: this
        // job needs none of the usual harness preamble, and not sending it is
        // most of the saving.
        '--system-prompt', SYSTEM_PROMPT,
        // Pure text in, text out — loading MCP servers or tools would cost
        // more than the summary itself.
        '--strict-mcp-config',
        '--disallowed-tools', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('brief timed out'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `brief exited ${code}`));
    });

    child.stdin.end(prompt);
  });
}

function str(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function strList(value, max, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v, max)).filter(Boolean).slice(0, limit);
}

// In practice the model wraps the object in a ```json fence despite being told
// not to, so strip one rather than throwing away an otherwise good brief.
function parseBrief(raw) {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let obj;
  try {
    obj = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const headline = str(obj?.headline, 140);
  if (!headline) return null; // a brief with no headline isn't worth showing

  return {
    headline,
    why: str(obj.why, 300),
    state: str(obj.state, 600),
    who: Array.isArray(obj.who)
      ? obj.who
          .map((w) => ({
            name: str(w?.name, 60),
            doing: str(w?.doing, 120),
            why: str(w?.why, 120),
          }))
          .filter((w) => w.name && w.doing)
          .slice(0, 8)
      : [],
    waitingOnYou: strList(obj.waitingOnYou, 160, 6),
    recent: strList(obj.recent, 140, 4),
  };
}

function renderPriorBrief(brief) {
  if (!brief) return '(no brief yet — this is the first update)';
  return JSON.stringify(
    {
      headline: brief.headline,
      why: brief.why,
      state: brief.state,
      who: brief.who,
      waitingOnYou: brief.waitingOnYou,
      recent: brief.recent,
    },
    null,
    1
  );
}

export async function updateRoomBrief({ roomName, charter, memberNames, brief, messages }) {
  if (!messages.length) return null;

  let transcript = messages
    .map((m) => `${m.sender}: ${m.text.slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n\n');
  if (transcript.length > MAX_BURST_CHARS) {
    // Keep the newest, which is what the brief is being updated to reflect.
    transcript = `[earlier messages truncated]\n\n${transcript.slice(-MAX_BURST_CHARS)}`;
  }

  const prompt = [
    `Room: #${roomName}`,
    charter ? `Room purpose: ${charter}` : null,
    `Agent members: ${memberNames.join(', ')}`,
    '',
    'CURRENT BRIEF:',
    renderPriorBrief(brief),
    '',
    'NEW MESSAGES SINCE THAT BRIEF:',
    transcript,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const raw = await schedule(() => runOneShot(prompt));
  return parseBrief(raw);
}
