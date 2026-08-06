import { spawn } from 'node:child_process';

// ---- Per-message digests for the group-chat overview panel ----------------
// A room of three agents produces more text, faster, than anyone is going to
// read. This turns each agent message into one status line, so the human can
// follow what's happening without reading the transcript — and, critically,
// notice when they're the one being asked something.
//
// Each digest is a separate one-shot `claude --print` on the cheapest model:
// no session, no --resume, no history. That's deliberate. A long-lived
// summarizer session would re-send the whole growing transcript on every
// message, which is the opposite of the point; one message in, one line out,
// constant cost per message no matter how long the discussion runs.

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DIGEST_MODEL = process.env.DIGEST_MODEL || 'haiku';

// Digests are strictly best-effort garnish on top of a room that works
// without them, so they must never compete with the actual agents for
// machine resources.
const MAX_CONCURRENT = 2;
const MAX_INPUT_CHARS = 6000;
const TIMEOUT_MS = 90000;

const VALID_TAGS = ['decision', 'question', 'progress', 'problem', 'done'];

// The human is identified by *absence* from the member list rather than by a
// configured list of aliases — they get called "cansyland", "the operator",
// "the human" or just "you" depending on which agent is talking, and no alias
// list would keep up. Anything addressed to a name that isn't an agent in this
// room is addressed to them.
const SYSTEM_PROMPT = `You compress ONE message from a multi-agent group chat into a status line for the human operator, who is not reading the full transcript.

You will be given the room purpose, the list of AI agent members, the sender, and the message. The human operator is the only participant who is NOT in the agent member list — so a message addressed to any name that is not an agent member (or to "operator", "human", "the user", or an unqualified "you") is addressed to the human.

Return ONLY a JSON object. No markdown fence, no commentary.
{"gist": string, "addressesHuman": boolean, "ask": string|null, "tag": "decision"|"question"|"progress"|"problem"|"done"}

- gist: max 110 chars, plain language, what this message actually says or does. Not "the agent explains that..." — just the substance.
- addressesHuman: true only if the message needs something FROM the human: a decision, approval, information, or an action. Agents talking to each other is false.
- ask: if addressesHuman, max 80 chars stating exactly what is wanted from them. Else null.`;

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
        '--model', DIGEST_MODEL,
        // Replaces the default system prompt rather than appending to it: this
        // job needs none of the usual harness preamble, and not sending it is
        // most of the token saving.
        '--system-prompt', SYSTEM_PROMPT,
        // No MCP servers, no tools — this is pure text-in/text-out, and
        // loading either would cost more than the summary itself.
        '--strict-mcp-config',
        '--disallowed-tools', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('digest timed out'));
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
      else reject(new Error(err.trim() || `digest exited ${code}`));
    });

    child.stdin.end(prompt);
  });
}

// In practice the model wraps the object in a ```json fence despite being told
// not to, so strip one rather than throwing away an otherwise good digest.
function parseDigest(raw) {
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
  if (!obj || typeof obj.gist !== 'string' || !obj.gist.trim()) return null;

  const addressesHuman = obj.addressesHuman === true;
  return {
    gist: obj.gist.trim().slice(0, 200),
    addressesHuman,
    ask: addressesHuman && typeof obj.ask === 'string' && obj.ask.trim() ? obj.ask.trim().slice(0, 160) : null,
    tag: VALID_TAGS.includes(obj.tag) ? obj.tag : 'progress',
  };
}

export async function digestRoomMessage({ roomName, charter, memberNames, senderName, text }) {
  const prompt = [
    `Room: #${roomName}`,
    charter ? `Room purpose: ${charter}` : null,
    `Agent members: ${memberNames.join(', ')}`,
    `Sender: ${senderName}`,
    `Message: ${text.slice(0, MAX_INPUT_CHARS)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await schedule(() => runOneShot(prompt));
  return parseDigest(raw);
}
