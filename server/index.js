import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

import { store } from './store.js';
import { requireAuth, checkToken, isBanned, recordFailure, recordSuccess, timingSafeEqual, DEVICE_TOKEN } from './auth.js';
import { sendPush, VAPID_PUBLIC_KEY } from './push.js';
import { ClaudeBridge } from './claudeBridge.js';

const PORT = process.env.PORT || 8720;
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'data', 'pairing-code.secret');
const DEFAULT_WORKDIR = process.env.CLAUDE_WORKDIR || process.env.HOME;
const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const VALID_PROVIDERS = ['anthropic', 'openrouter'];

// Free-tier/alt-model routing: OpenRouter exposes an Anthropic-Messages-API
// -compatible endpoint, so the same `claude --model <id>` mechanism works —
// it just needs three extra env vars on that one agent's child process.
// Key lives in data/ (gitignored), never in agents.json or the repo.
const OPENROUTER_KEY_FILE = path.join(process.cwd(), 'data', 'openrouter-key.secret');
function openRouterEnv() {
  let key;
  try {
    key = fs.readFileSync(OPENROUTER_KEY_FILE, 'utf8').trim();
  } catch {
    return null;
  }
  if (!key) return null;
  return { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' };
}
function bridgeConfigKey(agent) {
  return `${agent.provider || 'anthropic'}::${agent.model || ''}`;
}

// "You've hit your session limit · resets 2:30am (UTC)" — matched leniently
// (only the digits + am/pm + UTC actually matter for scheduling the retry)
// since Anthropic could tweak the exact separator/wording around it. The
// minutes group is optional: on an exact hour the CLI drops it entirely
// ("resets 5pm (UTC)", no ":00") — missing that format once already caused
// a real detection failure, so this is now deliberately tested against both.
const SESSION_LIMIT_RE = /session limit.*?resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i;

function parseSessionLimitReset(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(SESSION_LIMIT_RE);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPm = /pm/i.test(m[3]);
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  const now = new Date();
  let target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
  if (target.getTime() <= now.getTime()) target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  return target;
}

// Parses the reply from a `/usage` slash command, e.g.:
//   "Current session: 94% used · resets Jul 25, 5pm (UTC)"
//   "Current week (all models): 91% used · resets Jul 29, 11am (UTC)"
// Lenient on the punctuation between "used" and "resets" since that's just
// a separator character, not meaningful structure.
function parseUsageText(text) {
  if (typeof text !== 'string') return null;
  const sessionMatch = text.match(/Current session:\s*(\d+)%\s*used.*?resets\s+([^\n]+)/i);
  const weekMatch = text.match(/Current week[^:\n]*:\s*(\d+)%\s*used.*?resets\s+([^\n]+)/i);
  if (!sessionMatch && !weekMatch) return null;
  return {
    session: sessionMatch ? { percent: parseInt(sessionMatch[1], 10), resetsLabel: sessionMatch[2].trim() } : null,
    week: weekMatch ? { percent: parseInt(weekMatch[1], 10), resetsLabel: weekMatch[2].trim() } : null,
  };
}

// Parses the reply from a `/context` slash command. The CLI renders it as a
// markdown report whose one line we care about is:
//   "**Tokens:** 43.8k / 200k (22%)"
// Numbers carry k/M suffixes and the percentage is only shown rounded, so the
// token counts — not the printed percent — are the authoritative figure.
const CONTEXT_TOKENS_RE = /\*{0,2}Tokens:?\*{0,2}\s*([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)/;

function parseTokenCount(value, suffix) {
  const n = parseFloat(value.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = /^[kK]$/.test(suffix) ? 1e3 : /^[mM]$/.test(suffix) ? 1e6 : 1;
  return Math.round(n * scale);
}

function parseContextText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(CONTEXT_TOKENS_RE);
  if (!match) return null;

  const tokensUsed = parseTokenCount(match[1], match[2]);
  const tokensTotal = parseTokenCount(match[3], match[4]);
  if (!tokensUsed || !tokensTotal) return null;

  return {
    percent: Math.min(100, Math.round((tokensUsed / tokensTotal) * 100)),
    detail: `${match[1]}${match[2]} / ${match[3]}${match[4]} tokens`,
    tokensUsed,
    tokensTotal,
  };
}

// Changes every daemon restart, which happens on every deploy — a cheap,
// zero-maintenance build fingerprint for the settings panel.
const BUILD_VERSION = new Date().toISOString();

const app = express();
app.set('trust proxy', true); // behind nginx; req.ip should reflect the real client
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// ---- One-time pairing: unauthenticated by necessity (the device doesn't have
// the bearer token yet), so it's gated by its own single-use code + the same
// brute-force ban list used for the real token, and permanently disabled the
// moment any device successfully pairs. ----
app.get('/api/pair-status', (req, res) => {
  res.json({ paired: store.isPaired() });
});

app.post('/api/pair', (req, res) => {
  const ip = req.ip;
  if (isBanned(ip)) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  if (store.isPaired()) {
    return res.status(410).json({ error: 'already paired' });
  }
  const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  const expected = fs.readFileSync(PAIRING_CODE_FILE, 'utf8').trim();
  if (!code || !timingSafeEqual(code, expected)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'invalid code' });
  }
  recordSuccess(ip);
  store.setPaired(true);
  res.json({ token: DEVICE_TOKEN });
});

app.get('/api/version', requireAuth, (req, res) => {
  res.json({ version: BUILD_VERSION });
});

// Manual restart from the settings panel. Responds first, then exits after
// a short delay so the response actually reaches the client before the
// socket goes away — systemd's Restart=always brings the process back up
// within a few seconds, same as a manual `systemctl restart`. The client's
// own WebSocket reconnect + connection banner is what shows progress; there
// is no separate "restarting" protocol message, the dropped connection IS
// the signal.
app.post('/api/restart', requireAuth, (req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    for (const { bridge } of runtimes.values()) bridge.stop();
    process.exit(0);
  }, 300);
});

// ---- Agent runtime: one persistent Claude session per agent, all running
// concurrently in this one process. Keyed by agentId. ----
const runtimes = new Map(); // agentId -> { bridge, currentTurn, liveDeltaBuffer, turnStartedAt, activeToolName }

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// A client "is viewing" an agent when its chat is the open screen AND the
// app is foregrounded — either condition failing means a reply should still
// count as unread / worth a push.
function anyClientViewing(agentId) {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.isVisible && ws.openAgentId === agentId) return true;
  }
  return false;
}

function totalUnread() {
  return store.listAgents().reduce((sum, a) => sum + store.getUnreadCount(a.id), 0);
}

function toolResultPreview(content) {
  if (typeof content === 'string') return content.slice(0, 1500);
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c.text || ''))
      .join('\n')
      .slice(0, 1500);
  }
  return '';
}

function lastActivityTs(agentId) {
  const messages = store.getMessages(agentId);
  const last = messages[messages.length - 1];
  return last ? last.ts : 0;
}

function rosterEntry(agent) {
  const messages = store.getMessages(agent.id);
  const last = messages[messages.length - 1] || null;
  const runtime = runtimes.get(agent.id);
  return {
    id: agent.id,
    name: agent.name,
    emoji: agent.emoji,
    color: agent.color,
    workdir: agent.workdir,
    systemPrompt: agent.systemPrompt,
    model: agent.model || 'sonnet',
    provider: agent.provider || 'anthropic',
    slashCommands: runtime?.slashCommands || [],
    unreadCount: store.getUnreadCount(agent.id),
    lastMessage: last ? { text: last.text, role: last.role, ts: last.ts } : null,
    working: runtime?.turnStartedAt ? liveTurnState(runtime) : null,
    compacting: runtime?.compacting ? { startedAt: runtime.compacting.startedAt } : null,
    sleeping: !runtime,
  };
}

// Everything a client needs to reconstruct the in-flight turn from scratch —
// not just "something is happening" but what, so far. Used by both the
// roster (list-view working-dot / reconnect) and the messages endpoint
// (opening/reopening a chat mid-turn): the tool calls made so far, the
// thinking accumulated so far, and the streamed reply text so far, none of
// which otherwise exist anywhere but the live broadcast events a client
// would have had to already be listening for.
function liveTurnState(runtime) {
  return {
    startedAt: runtime.turnStartedAt,
    tool: runtime.activeToolName,
    waitingUntil: runtime.waitingUntil || null,
    tools: runtime.currentTurn?.tools || [],
    thinkingText: runtime.liveThinkingText || '',
    thinkingTokens: runtime.liveThinkingTokens || 0,
    deltaText: runtime.liveDeltaBuffer || '',
  };
}

function buildRoster() {
  return store.listAgents().map(rosterEntry);
}

function broadcastRosterEntry(agentId) {
  const agent = store.getAgent(agentId);
  if (agent) broadcast({ type: 'roster_entry', agent: rosterEntry(agent) });
}

// Every agent gets this, regardless of persona — otherwise there's no way
// for an agent to know its own id (needed for its own /api/agents/:id/...
// calls) short of a human telling it out of band. Full API details live in
// the shared memory system instead of here, since every agent in this app
// shares the same home directory and therefore the same auto-loaded memory.
const AGENTS_DOC_FILE = path.join(process.cwd(), 'AGENTS.md');
const TOKEN_FILE_PATH = path.join(process.cwd(), 'data', 'device-token.secret');

function buildFullSystemPrompt(agent) {
  // Lives in the repo (AGENTS.md), not personal memory — so it ships with
  // every install automatically instead of needing to be hand-copied into
  // each account's own memory system. Port/token path are computed per
  // install, never hardcoded, so nothing here needs editing on a new deploy.
  const selfContext = `[xqlytskg-chat context: you are agent "${agent.name}" (id: ${agent.id}) inside this chat app. Base URL: http://127.0.0.1:${PORT} — auth token is the contents of ${TOKEN_FILE_PATH}. This app's own extra features (task list, etc.) are documented in ${AGENTS_DOC_FILE} — read it when you need the details.]`;
  return agent.systemPrompt ? `${selfContext}\n\n${agent.systemPrompt}` : selfContext;
}

function startAgentBridge(agent) {
  const bridge = new ClaudeBridge({
    sessionId: agent.sessionId,
    workdir: agent.workdir,
    systemPrompt: buildFullSystemPrompt(agent),
    model: agent.model,
    extraEnv: agent.provider === 'openrouter' ? openRouterEnv() : null,
  });
  bridge.configKey = bridgeConfigKey(agent);
  const runtime = {
    bridge, currentTurn: null, liveDeltaBuffer: '', turnStartedAt: null, activeToolName: null,
    interrupted: false, waitingUntil: null, lastUserText: null, retryTimeoutId: null, slashCommands: [],
    usageProbe: 0, // counter: number of pending probe commands (usage, context, etc.)
    compacting: null, // { startedAt, tokensBefore } while a /compact is in flight
    compactedAt: null, // carries the finished compaction until the after-probe lands
    // Thinking, accumulated live and persisted with the turn's final message
    // so it survives a reconnect the same way tool calls do (see the
    // liveThinkingText/liveThinkingTokens fields below, mirrored into the
    // roster/messages endpoints for replay). Anthropic-native models redact
    // the actual text server-side before it reaches the CLI — only a
    // cumulative token estimate comes through in that case — so
    // liveThinkingText stays '' and liveThinkingTokens is the only signal.
    // OpenRouter models are not redacted and stream real text into both.
    liveThinkingText: '',
    liveThinkingTokens: 0,
  };
  runtimes.set(agent.id, runtime);

  bridge.on('ready', ({ sessionId, slashCommands }) => {
    store.setAgentSessionId(agent.id, sessionId);
    runtime.slashCommands = slashCommands || [];
    broadcastRosterEntry(agent.id);
  });

  bridge.on('delta', (text) => {
    runtime.liveDeltaBuffer += text;
    broadcast({ type: 'delta', agentId: agent.id, text });
  });

  bridge.on('thinking_start', () => {
    runtime.liveThinkingText = '';
    runtime.liveThinkingTokens = 0;
    broadcast({ type: 'thinking_start', agentId: agent.id });
  });

  bridge.on('thinking_delta', ({ text, estimatedTokens }) => {
    if (text) runtime.liveThinkingText += text;
    if (estimatedTokens) runtime.liveThinkingTokens += estimatedTokens;
    broadcast({ type: 'thinking_delta', agentId: agent.id, text, tokens: runtime.liveThinkingTokens });
  });

  bridge.on('thinking_final', ({ text }) => {
    // The CLI's own final block is authoritative over whatever was
    // accumulated from deltas — covers cases where a delta was missed, and
    // is a no-op when the two already agree.
    runtime.liveThinkingText = text;
  });

  bridge.on('tool_use', ({ id, name, input }) => {
    if (!runtime.currentTurn) runtime.currentTurn = { tools: [] };
    runtime.currentTurn.tools.push({ id, name, input, result: null, isError: false });
    runtime.activeToolName = name;
    broadcast({ type: 'tool_use', agentId: agent.id, id, name, input });
    broadcastRosterEntry(agent.id);
  });

  bridge.on('tool_result', ({ toolUseId, isError, content }) => {
    if (!runtime.currentTurn) runtime.currentTurn = { tools: [] };
    const tool = runtime.currentTurn.tools.find((t) => t.id === toolUseId);
    const preview = toolResultPreview(content);
    if (tool) {
      tool.result = preview;
      tool.isError = isError;
    }
    runtime.activeToolName = null;
    broadcast({ type: 'tool_result', agentId: agent.id, toolUseId, isError, preview });
    broadcastRosterEntry(agent.id);
  });

  bridge.on('turn_done', async ({ text, isError }) => {
    // Invisible background probes (/usage, /context, etc.) — never shown as
    // real messages, never counted as unread, don't touch rate-limit handling.
    if (runtime.usageProbe > 0) {
      runtime.usageProbe -= 1;
      // Each probe's reply is matched against both parsers rather than assumed
      // from send order — the CLI doesn't guarantee replies come back in the
      // order the commands went out, and a reply that matches neither (e.g.
      // /usage on an OpenRouter model, which returns a cost summary) is simply
      // ignored instead of clobbering a good reading.
      const parsedUsage = parseUsageText(text);
      const parsedContext = parseContextText(text);
      if (parsedUsage) runtime._probeUsage = parsedUsage;
      if (parsedContext) runtime._probeContext = parsedContext;
      // Only process and broadcast when both probes have returned
      if (runtime.usageProbe > 0) return;
      runtime.currentTurn = null;
      runtime.liveDeltaBuffer = '';
      runtime.turnStartedAt = null;
      runtime.activeToolName = null;
      if (runtime._probeUsage || runtime._probeContext) {
        // Only overwrite a field this probe cycle actually resolved — a cycle
        // where one command's reply didn't parse must leave the other's last
        // known value alone rather than blanking it to undefined.
        latestUsage = { ...latestUsage, ...runtime._probeUsage, updatedAt: Date.now() };
        if (runtime._probeContext) latestUsage.context = runtime._probeContext;
        broadcast({ type: 'usage_update', usage: latestUsage });
      }

      // This probe was the one kicked off right after a /compact finished, so
      // its context reading is the "after" figure — pair it with the "before"
      // captured at send time to report a real, measured token delta.
      const done = runtime.compactedAt;
      if (done) {
        runtime.compactedAt = null;
        broadcast({
          type: 'compact_done',
          agentId: agent.id,
          tokensBefore: done.tokensBefore,
          tokensAfter: runtime._probeContext?.tokensUsed ?? null,
          percentAfter: runtime._probeContext?.percent ?? null,
          durationMs: done.durationMs,
          wasInterrupted: done.wasInterrupted,
          isError: done.isError,
        });
      }

      delete runtime._probeUsage;
      delete runtime._probeContext;
      broadcastRosterEntry(agent.id); // clears the brief working-indicator state
      return;
    }

    // A user-requested stop: the CLI's own result text for an interrupted
    // turn isn't useful (empty/error-shaped), so keep whatever had already
    // streamed to the client instead — same idea as "stop generating"
    // elsewhere, the partial answer becomes the final one.
    const wasInterrupted = runtime.interrupted;
    runtime.interrupted = false;

    // Hit the account's session limit: rather than showing this as a failed
    // reply and leaving the user to notice and resend by hand, schedule an
    // automatic resend of the same message once the limit resets. Nothing
    // is saved to the chat as an error — the eventual real reply is the
    // only message that ends up in history, same as if it had just taken a
    // few hours to think.
    if (!wasInterrupted && isError) {
      const resetAt = parseSessionLimitReset(text);
      if (resetAt) {
        runtime.currentTurn = null;
        runtime.liveDeltaBuffer = '';
        runtime.liveThinkingText = '';
        runtime.liveThinkingTokens = 0;
        runtime.activeToolName = null;
        runtime.waitingUntil = resetAt.getTime();
        // turnStartedAt deliberately stays set — this agent is still
        // "busy" (waiting to retry), which also keeps it out of the
        // idle-sleep sweep for the duration of the wait.
        store.updateAgent(agent.id, { waitingUntil: runtime.waitingUntil, lastUserText: runtime.lastUserText });
        broadcast({ type: 'waiting', agentId: agent.id, resumesAt: runtime.waitingUntil });
        broadcastRosterEntry(agent.id);
        scheduleRetry(agent.id, resetAt);
        return;
      }
    }

    const finalText = wasInterrupted ? (runtime.liveDeltaBuffer || '_Stopped before responding._') : text;

    const message = {
      id: randomUUID(),
      role: 'assistant',
      text: finalText,
      ts: Date.now(),
      isError: wasInterrupted ? false : isError,
      tools: runtime.currentTurn?.tools || [],
      // Persisted alongside tools so it's collapsible the same way once the
      // turn is done, and so it survives a reconnect/history-load instead of
      // only existing during the live stream. '' (not null) on Anthropic-
      // native models, where the text itself is redacted server-side — the
      // token count is kept regardless, since that part is never redacted.
      thinking: runtime.liveThinkingText || '',
      thinkingTokens: runtime.liveThinkingTokens || null,
    };
    store.addMessage(agent.id, message);
    broadcast({ type: 'assistant_message', agentId: agent.id, message });

    // A finished /compact gets an explicit end-of-compaction marker rather
    // than leaving the user to infer it from the indicator disappearing.
    // The CLI reports no progress while compacting, so the only honest
    // figures are elapsed time and the before/after context reading — the
    // latter arrives via the refreshUsage() probe below, so the token delta
    // is filled in later by the usage_update rather than guessed at here.
    const compacting = runtime.compacting;
    runtime.compacting = null;

    runtime.currentTurn = null;
    runtime.liveDeltaBuffer = '';
    runtime.liveThinkingText = '';
    runtime.liveThinkingTokens = 0;
    runtime.turnStartedAt = null;
    runtime.activeToolName = null;
    broadcastRosterEntry(agent.id);

    if (compacting) {
      runtime.compactedAt = {
        tokensBefore: compacting.tokensBefore,
        durationMs: Date.now() - compacting.startedAt,
        wasInterrupted,
        isError: !wasInterrupted && isError,
      };
    }
    refreshUsage(agent.id); // a real turn just spent tokens — the numbers may have moved

    if (!wasInterrupted && !anyClientViewing(agent.id)) {
      store.incrementUnread(agent.id);
      const current = store.getAgent(agent.id) || agent;
      await sendPush({
        title: `${current.emoji ? current.emoji + ' ' : ''}${current.name}`,
        body: text.slice(0, 180) || 'New response',
        unread: totalUnread(),
        agentId: agent.id,
      });
    }
  });

  bridge.on('crash', () => {
    // The in-flight turn (if any) died with the process — nothing will ever
    // emit turn_done for it, so the working indicator must be cleared here or
    // it sits on every client's screen counting up forever.
    runtime.currentTurn = null;
    runtime.liveDeltaBuffer = '';
    runtime.liveThinkingText = '';
    runtime.liveThinkingTokens = 0;
    runtime.turnStartedAt = null;
    runtime.activeToolName = null;
    // A compaction that died with the process will never reach turn_done, so
    // clear the flag here or the client's indicator runs forever.
    runtime.compacting = null;
    runtime.compactedAt = null;
    broadcast({ type: 'compact_done', agentId: agent.id, crashed: true });
    broadcast({ type: 'system', agentId: agent.id, text: `${agent.name}: process restarting…` });
    broadcastRosterEntry(agent.id);
  });

  bridge.on('stderr', (text) => {
    console.error(`[claude stderr:${agent.id}]`, text.trim());
  });

  bridge.start();

  // If this agent was mid-wait for a session-limit reset when the server
  // last stopped (a restart, a deploy, the settings-panel restart button —
  // all common enough in this app that losing the whole point of "don't
  // make me monitor it" on every restart would defeat the feature), pick
  // the wait back up rather than silently dropping it. If the reset time
  // already passed while the server was down, this retries right away.
  if (agent.waitingUntil) {
    runtime.waitingUntil = agent.waitingUntil;
    runtime.lastUserText = agent.lastUserText || null;
    runtime.turnStartedAt = Date.now();
    scheduleRetry(agent.id, new Date(agent.waitingUntil));
  }

  return runtime;
}

// Cleanly stops an agent's Claude process and drops its runtime — the agent
// itself (and its session id, so `--resume` picks the conversation right
// back up) lives on in the store; this only affects whether a process is
// currently resident. Absence from `runtimes` *is* the "sleeping" state.
function stopAgentBridge(agentId) {
  const runtime = runtimes.get(agentId);
  if (!runtime) return;
  runtime.bridge.stop();
  runtimes.delete(agentId);
}

// Schedules the automatic resend of an agent's last message once its
// session limit resets. A generous +60s safety margin past the stated
// reset time absorbs clock skew against Anthropic's servers — retrying a
// few seconds late is free, retrying early just means hitting the same
// limit again for nothing.
function scheduleRetry(agentId, resetAt) {
  const runtime = runtimes.get(agentId);
  if (!runtime) return;
  if (runtime.retryTimeoutId) clearTimeout(runtime.retryTimeoutId);
  const delay = Math.max(1000, resetAt.getTime() - Date.now() + 60000);
  runtime.retryTimeoutId = setTimeout(() => attemptRetrySend(agentId, 0), delay);
}

function attemptRetrySend(agentId, attempt) {
  const runtime = runtimes.get(agentId);
  if (!runtime || !runtime.waitingUntil) return; // cancelled, deleted, or agent asleep
  const text = runtime.lastUserText;
  if (!text) return;
  try {
    runtime.bridge.send(text);
    runtime.waitingUntil = null;
    runtime.retryTimeoutId = null;
    runtime.turnStartedAt = Date.now();
    runtime.activeToolName = null;
    store.updateAgent(agentId, { waitingUntil: null });
    broadcast({ type: 'turn_started', agentId });
    broadcastRosterEntry(agentId);
  } catch (err) {
    // Most likely the bridge process hasn't finished (re)spawning yet
    // (e.g. it happened to exit around the same time for an unrelated
    // reason) — a few short retries covers that without giving up on the
    // whole point of this feature over a transient timing issue.
    if (attempt >= 5) {
      broadcast({ type: 'system', agentId, text: `Auto-retry failed: ${err.message}` });
      return;
    }
    runtime.retryTimeoutId = setTimeout(() => attemptRetrySend(agentId, attempt + 1), 3000);
  }
}

for (const agent of store.listAgents()) startAgentBridge(agent);

// ---- Idle sleep: an agent nobody has messaged in a day is pure idle
// memory (~200MB+ per resident `claude` process) for no benefit — waking
// it back up on the next message is just a normal --resume, so there's no
// real cost to letting it go to sleep in between. ----
const IDLE_SLEEP_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [agentId, runtime] of runtimes) {
    if (runtime.turnStartedAt) continue; // never sleep mid-turn
    if (now - lastActivityTs(agentId) > IDLE_SLEEP_MS) {
      stopAgentBridge(agentId);
      broadcastRosterEntry(agentId);
    }
  }
}, 60 * 60 * 1000); // hourly check is plenty coarse for a ~24h threshold

// ---- Account usage tracking: the CLI doesn't push this proactively, so we
// ask via an invisible `/usage` probe whenever the numbers could plausibly
// have changed (see the two call sites below) — account-wide, so it's
// stored globally rather than per-agent. The probe is invisible (handled
// specially in turn_done), so it won't flicker a stray "Thinking…" into view.
let latestUsage = null; // { session: {...}|null, week: {...}|null, context: {...}|null, updatedAt }

// Context is per-session, not account-wide like session/week, so the probe
// prefers the agent whose chat is actually open — otherwise the bar would
// report some unrelated background agent's context. Only ever probes an idle
// agent: setting usageProbe on a busy one makes turn_done swallow that real
// turn's reply as a probe response, losing the user's answer entirely.
function refreshUsage(viewedAgentId) {
  const candidates = viewedAgentId && runtimes.has(viewedAgentId)
    ? [viewedAgentId, ...runtimes.keys()]
    : [...runtimes.keys()];

  for (const agentId of candidates) {
    const runtime = runtimes.get(agentId);
    if (!runtime || runtime.turnStartedAt) continue; // busy with something real
    runtime.usageProbe = 2;
    try {
      runtime.bridge.send('/usage');
      runtime.bridge.send('/context');
      runtime.turnStartedAt = Date.now();
    } catch {
      runtime.usageProbe = 0;
    }
    return; // one probe per cycle is enough
  }
}

// Triggered from two places instead of on a timer — usage only actually
// changes when a real turn finishes (tokens got spent) or when a client
// freshly connects (worth a check on app load), so anything in between is
// just the same numbers again.

app.get('/api/roster', requireAuth, (req, res) => {
  res.json({ agents: buildRoster(), vapidPublicKey: VAPID_PUBLIC_KEY, usage: latestUsage });
});

app.get('/api/agents/:id/messages', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });

  // Pagination: limit (default 10, max 100), before (message id to load older than)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const before = req.query.before || null;

  const allMessages = store.getMessages(agent.id);
  let messages = allMessages;
  let beforeIdx = -1;

  if (before) {
    beforeIdx = allMessages.findIndex(m => m.id === before);
    if (beforeIdx >= 0) {
      messages = allMessages.slice(0, beforeIdx);
    }
  }

  // Return newest first (slice from end)
  messages = messages.slice(-limit);

  const runtime = runtimes.get(agent.id);
  const hasMore = before
    ? messages.length === limit && beforeIdx > 0
    : allMessages.length > limit;
  res.json({
    messages,
    hasMore,
    totalCount: allMessages.length,
    working: runtime?.turnStartedAt ? liveTurnState(runtime) : null,
    compacting: runtime?.compacting ? { startedAt: runtime.compacting.startedAt } : null,
  });
});

function broadcastTodos(agentId) {
  broadcast({ type: 'todos_update', agentId, todos: store.getTodos(agentId) });
}

app.get('/api/agents/:id/todos', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  res.json({ todos: store.getTodos(agent.id) });
});

app.post('/api/agents/:id/todos', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 500) : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  const todo = store.addTodo(agent.id, text);
  broadcastTodos(agent.id);
  res.json({ todo });
});

app.patch('/api/agents/:id/todos/:todoId', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const patch = {};
  if (typeof req.body.text === 'string' && req.body.text.trim()) patch.text = req.body.text.trim().slice(0, 500);
  if (req.body.status === 'open' || req.body.status === 'done') patch.status = req.body.status;
  const todo = store.updateTodo(agent.id, req.params.todoId, patch);
  if (!todo) return res.status(404).json({ error: 'no such todo' });
  broadcastTodos(agent.id);
  res.json({ todo });
});

app.post('/api/agents/:id/todos/:todoId/move', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const direction = req.body.direction === 'up' || req.body.direction === 'down' ? req.body.direction : null;
  if (!direction) return res.status(400).json({ error: 'direction must be up or down' });
  const moved = store.moveTodo(agent.id, req.params.todoId, direction);
  broadcastTodos(agent.id);
  res.json({ ok: moved });
});

app.delete('/api/agents/:id/todos/:todoId', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const removed = store.removeTodo(agent.id, req.params.todoId);
  broadcastTodos(agent.id);
  res.json({ ok: removed });
});

app.post('/api/agents', requireAuth, (req, res) => {
  const { name, emoji, color, workdir, systemPrompt, model, provider } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  if (typeof emoji !== 'string' || !emoji.trim()) {
    return res.status(400).json({ error: 'emoji required' });
  }
  const dir = typeof workdir === 'string' && workdir.trim() ? workdir.trim() : DEFAULT_WORKDIR;
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return res.status(400).json({ error: 'working directory does not exist' });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'working directory is not a directory' });
  }
  if (provider !== undefined && !VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
  }
  const isOpenRouter = provider === 'openrouter';
  if (isOpenRouter) {
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: 'model (OpenRouter model id) is required when provider is openrouter' });
    }
  } else if (model !== undefined && !VALID_MODELS.includes(model)) {
    return res.status(400).json({ error: `model must be one of: ${VALID_MODELS.join(', ')}` });
  }

  const agent = store.createAgent({
    name: name.trim().slice(0, 60),
    emoji: emoji.trim().slice(0, 8),
    color: typeof color === 'string' && color ? color : '#7c9cff',
    workdir: dir,
    systemPrompt: typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt.trim().slice(0, 4000) : null,
    model: isOpenRouter ? model.trim().slice(0, 200) : (VALID_MODELS.includes(model) ? model : null),
    provider: isOpenRouter ? 'openrouter' : null,
  });
  startAgentBridge(agent);
  broadcast({ type: 'roster_entry', agent: rosterEntry(agent) });
  res.json({ agent: rosterEntry(agent) });
});

app.patch('/api/agents/:id', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const body = req.body || {};
  const patch = {};

  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
  if (typeof body.emoji === 'string' && body.emoji.trim()) patch.emoji = body.emoji.trim().slice(0, 8);
  if (typeof body.color === 'string' && body.color) patch.color = body.color;

  // workdir/systemPrompt are baked into the running process's spawn args —
  // changing them only takes effect once that process is restarted.
  let bridgeParamsChanged = false;
  if (typeof body.workdir === 'string' && body.workdir.trim() && body.workdir.trim() !== agent.workdir) {
    const dir = body.workdir.trim();
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      return res.status(400).json({ error: 'working directory does not exist' });
    }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'working directory is not a directory' });
    patch.workdir = dir;
    bridgeParamsChanged = true;
  }
  if (typeof body.systemPrompt === 'string') {
    const sp = body.systemPrompt.trim() ? body.systemPrompt.trim().slice(0, 4000) : null;
    if (sp !== agent.systemPrompt) {
      patch.systemPrompt = sp;
      bridgeParamsChanged = true;
    }
  }
  // Model/provider are intentionally NOT restarted here, unlike workdir/
  // systemPrompt — picking a new model shouldn't kill whatever that agent's
  // process is doing right now. It's just persisted; the WS message handler
  // restarts the bridge with the new config right before the *next* message
  // is sent, when there's nothing in flight to disturb.
  if (body.provider !== undefined || body.model !== undefined) {
    const nextProvider = body.provider !== undefined ? body.provider : (agent.provider || 'anthropic');
    if (!VALID_PROVIDERS.includes(nextProvider)) {
      return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
    }
    const nextModel = body.model !== undefined ? body.model : agent.model;
    if (nextProvider === 'openrouter') {
      if (typeof nextModel !== 'string' || !nextModel.trim()) {
        return res.status(400).json({ error: 'model (OpenRouter model id) is required when provider is openrouter' });
      }
      patch.model = nextModel.trim().slice(0, 200);
    } else {
      if (nextModel != null && !VALID_MODELS.includes(nextModel)) {
        return res.status(400).json({ error: `model must be one of: ${VALID_MODELS.join(', ')}` });
      }
      patch.model = VALID_MODELS.includes(nextModel) ? nextModel : null;
    }
    patch.provider = nextProvider === 'anthropic' ? null : nextProvider;
  }

  const updated = store.updateAgent(agent.id, patch);
  if (bridgeParamsChanged && runtimes.has(agent.id)) {
    // Restart with the same session id so history/continuity is unaffected —
    // only the working directory / persona going forward actually changes.
    stopAgentBridge(agent.id);
    startAgentBridge(updated);
  }
  broadcastRosterEntry(agent.id);
  res.json({ agent: rosterEntry(updated) });
});

app.delete('/api/agents/:id', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  stopAgentBridge(agent.id);
  store.removeAgent(agent.id);
  broadcast({ type: 'agent_removed', agentId: agent.id });
  res.json({ ok: true });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  store.setPushSubscription((req.body || {}).subscription);
  res.json({ ok: true });
});

app.post('/api/read', requireAuth, (req, res) => {
  const agentId = typeof (req.body || {}).agentId === 'string' ? req.body.agentId : null;
  if (agentId) {
    store.clearUnread(agentId);
    broadcastRosterEntry(agentId);
  }
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const ip = req.socket.remoteAddress;

  if (isBanned(ip)) {
    ws.close(4290, 'too many attempts');
    return;
  }
  if (!checkToken(token)) {
    recordFailure(ip);
    console.error(`[auth] WS rejected from ${ip}: ${token ? `len=${token.length} prefix=${token.slice(0, 4)}…` : 'no token'}`);
    ws.close(4401, 'unauthorized');
    return;
  }
  recordSuccess(ip);

  ws.isVisible = true; // assume foregrounded until told otherwise
  ws.openAgentId = null; // which agent's chat (if any) is the open screen

  ws.send(JSON.stringify({ type: 'hello', agents: buildRoster(), usage: latestUsage }));
  refreshUsage(ws.openAgentId); // a fresh connection means the app was just (re)opened — worth a check

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'message' && typeof msg.agentId === 'string' && typeof msg.text === 'string' && msg.text.trim()) {
      let runtime = runtimes.get(msg.agentId);
      if (!runtime) {
        // Asleep (or never started) — waking it is just a normal --resume,
        // no different from how a brand-new agent starts its first bridge.
        // This also naturally picks up any pending model switch, since it
        // reads agent.model fresh from the store.
        const agent = store.getAgent(msg.agentId);
        if (!agent) return;
        runtime = startAgentBridge(agent);
        broadcastRosterEntry(msg.agentId);
      } else if (runtime.waitingUntil) {
        // A new message supersedes whatever was queued for auto-retry —
        // send this one instead, cancelling the scheduled resend of the
        // old text so it doesn't also fire later.
        if (runtime.retryTimeoutId) clearTimeout(runtime.retryTimeoutId);
        runtime.retryTimeoutId = null;
        runtime.waitingUntil = null;
        store.updateAgent(msg.agentId, { waitingUntil: null });
      } else if (!runtime.turnStartedAt) {
        // Already awake and idle — apply a pending model switch now, right
        // before this message, rather than the moment it was picked (which
        // could have been mid-turn on the old model).
        const agent = store.getAgent(msg.agentId);
        if (agent && runtime.bridge.configKey !== bridgeConfigKey(agent)) {
          stopAgentBridge(msg.agentId);
          runtime = startAgentBridge(agent);
          broadcastRosterEntry(msg.agentId);
        }
      }
      const userMessage = {
        id: randomUUID(),
        role: 'user',
        text: msg.text,
        ts: Date.now(),
      };
      store.addMessage(msg.agentId, userMessage);
      broadcast({ type: 'user_message', agentId: msg.agentId, message: userMessage });
      try {
        runtime.bridge.send(msg.text);
        runtime.lastUserText = msg.text;
        runtime.turnStartedAt = Date.now();
        runtime.activeToolName = null;
        // /compact is slow, silent, and emits no progress of its own, so flag
        // it here to give the client something specific to show instead of a
        // generic "Thinking". The context reading taken now is the "before"
        // half of the token delta reported when it finishes.
        if (/^\/compact\b/i.test(msg.text.trim())) {
          runtime.compacting = { startedAt: Date.now(), tokensBefore: latestUsage?.context?.tokensUsed ?? null };
          broadcast({ type: 'compacting', agentId: msg.agentId, startedAt: runtime.compacting.startedAt });
        }
        broadcastRosterEntry(msg.agentId);
      } catch (err) {
        broadcast({ type: 'system', agentId: msg.agentId, text: `error: ${err.message}` });
      }
    } else if (msg.type === 'stop' && typeof msg.agentId === 'string') {
      const runtime = runtimes.get(msg.agentId);
      if (runtime && runtime.waitingUntil) {
        // Nothing is actually running — cancel the scheduled auto-retry
        // instead of trying to interrupt a live turn that doesn't exist.
        if (runtime.retryTimeoutId) clearTimeout(runtime.retryTimeoutId);
        runtime.retryTimeoutId = null;
        runtime.waitingUntil = null;
        runtime.turnStartedAt = null;
        store.updateAgent(msg.agentId, { waitingUntil: null });
        broadcastRosterEntry(msg.agentId);
      } else if (runtime && runtime.turnStartedAt) {
        runtime.interrupted = true;
        runtime.bridge.interrupt();
      }
    } else if (msg.type === 'view') {
      // Which agent's chat (if any) is currently the open screen on this
      // connection — drives per-agent unread clearing and push suppression.
      ws.openAgentId = typeof msg.agentId === 'string' ? msg.agentId : null;
      if (ws.openAgentId && ws.isVisible) {
        store.clearUnread(ws.openAgentId);
        broadcastRosterEntry(ws.openAgentId);
      }
    } else if (msg.type === 'visibility') {
      ws.isVisible = !!msg.visible;
      if (ws.isVisible && ws.openAgentId) {
        store.clearUnread(ws.openAgentId);
        broadcastRosterEntry(ws.openAgentId);
      }
    } else if (msg.type === 'read' && ws.openAgentId) {
      store.clearUnread(ws.openAgentId);
      broadcastRosterEntry(ws.openAgentId);
    } else if (msg.type === 'refresh_usage') {
      refreshUsage(ws.openAgentId);
    }
  });
});

process.on('SIGTERM', () => {
  for (const { bridge } of runtimes.values()) bridge.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const { bridge } of runtimes.values()) bridge.stop();
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`xqlytskg-chat daemon listening on 127.0.0.1:${PORT}`);
});
