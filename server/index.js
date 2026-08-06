import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

import { store } from './store.js';
import { requireAuth, checkToken, isBanned, recordFailure, recordSuccess, timingSafeEqual, DEVICE_TOKEN } from './auth.js';
import { sendPush, VAPID_PUBLIC_KEY } from './push.js';
import { ClaudeBridge } from './claudeBridge.js';

const PORT = process.env.PORT || 8720;
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'data', 'pairing-code.secret');
const DEFAULT_WORKDIR = process.env.CLAUDE_WORKDIR || process.env.HOME;
const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Cap on a stored agent persona. Mirrored by PERSONA_MAX_CHARS in public/app.js,
// which shows a live counter — keep the two in sync. ~16k chars is ~4k tokens,
// which is a reasonable ceiling for a detailed project-specific persona.
const PERSONA_MAX_CHARS = 16000;
// The peer-facing one-liner. Short on purpose: it's repeated once per member
// in every group-chat delivery header, so a paragraph here is a paragraph
// every other agent re-reads on every single message.
const BLURB_MAX_CHARS = 200;
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
  return `${agent.provider || 'anthropic'}::${agent.model || ''}::${agent.effort || ''}`;
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

// Pulls the latest `main` from origin and restarts so the new code takes
// effect. --ff-only refuses to run if the working tree has diverged (it
// shouldn't — data/ and logs/ are gitignored) rather than silently merging
// or discarding anything. npm install only runs when package.json actually
// changed, since it's the slow part of every deploy.
app.post('/api/deploy', requireAuth, async (req, res) => {
  const cwd = process.cwd();
  try {
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd });
    const after = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

    if (before === after) {
      return res.json({ ok: true, updated: false });
    }

    const { stdout: changedFiles } = await execFileAsync('git', ['diff', '--name-only', before, after], { cwd });
    if (/(^|\n)package(-lock)?\.json$/.test(changedFiles)) {
      await execFileAsync('npm', ['install'], { cwd });
    }

    res.json({ ok: true, updated: true });
    setTimeout(() => {
      for (const { bridge } of runtimes.values()) bridge.stop();
      process.exit(0);
    }, 300);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.stderr?.toString().trim() || err.message || String(err) });
  }
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
  return store.listAgents().reduce((sum, a) => sum + store.getUnreadCount(a.id), 0)
    + store.listRooms().reduce((sum, r) => sum + store.getRoomUnread(r.id), 0);
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
    blurb: agent.blurb || null,
    model: agent.model || 'sonnet',
    provider: agent.provider || 'anthropic',
    effort: agent.effort || 'medium',
    slashCommands: runtime?.slashCommands || [],
    unreadCount: store.getUnreadCount(agent.id),
    openTodoCount: store.getTodos(agent.id).filter((t) => t.status !== 'done').length,
    // compact-summary entries carry no .text (they're a token-count marker,
    // not a chat message) — give the list-view preview a stand-in string
    // instead of undefined, which would crash extractOptions() client-side.
    lastMessage: last ? { text: last.text ?? 'Conversation compacted', role: last.role, ts: last.ts } : null,
    working: isReallyWorking(runtime) ? liveTurnState(runtime) : null,
    compacting: runtime?.compacting ? { startedAt: runtime.compacting.startedAt } : null,
    sleeping: !runtime,
    // This agent's own context reading, if one has ever been taken — so the
    // client has the right number the instant this agent's chat is opened,
    // rather than showing 0%/stale-other-agent data until the next probe
    // cycle happens to land on this specific agent.
    context: runtime?.latestContext || null,
  };
}

// turnStartedAt is also set while an invisible /usage or /context probe is
// in flight (see refreshUsage) — that's real bridge activity, just not
// anything the user asked for, so it must never surface as a "working"
// state a client would render a live bubble for.
function isReallyWorking(runtime) {
  return !!runtime?.turnStartedAt && !runtime.usageProbe;
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
  if (!agent) return;
  broadcast({ type: 'roster_entry', agent: rosterEntry(agent) });
  // A room's "who is replying right now" strip is derived from its members'
  // runtimes, so every change to an agent's working state is also a change to
  // every room it belongs to. Without this the chips latch on at the start of
  // a discussion and never clear.
  for (const room of store.listRooms()) {
    if (room.memberIds.includes(agentId)) broadcast({ type: 'room_entry', room: roomEntry(room) });
  }
}

// Every agent gets this, regardless of persona — otherwise there's no way
// for an agent to know its own id (needed for its own /api/agents/:id/...
// calls) short of a human telling it out of band. Full API details live in
// the shared memory system instead of here, since every agent in this app
// shares the same home directory and therefore the same auto-loaded memory.
const AGENTS_DOC_FILE = path.join(process.cwd(), 'AGENTS.md');
const TOKEN_FILE_PATH = path.join(process.cwd(), 'data', 'device-token.secret');

// The other agents on this install, as a one-line-each directory. Without it
// an agent has no way to know who else exists, so it can't sensibly @mention
// anyone in a group chat. Deliberately the short `blurb`, never the full
// persona: personas run to thousands of chars and are that agent's own
// private instructions, not a description meant for its peers.
function buildPeerDirectory(agent) {
  const peers = store.listAgents().filter((a) => a.id !== agent.id);
  if (!peers.length) return null;
  const lines = peers.map((a) => `- ${a.emoji || '🤖'} ${a.name} (id: ${a.id})${a.blurb ? ` — ${a.blurb}` : ''}`);
  return `Other agents in this app you can be put in a group chat with:\n${lines.join('\n')}`;
}

// Only the rooms this agent is actually in. A room it isn't a member of is
// none of its business, and listing every room would be exactly the "one big
// group chat is all distraction" problem in system-prompt form.
function buildRoomDirectory(agent) {
  const rooms = store.listRooms().filter((r) => r.memberIds.includes(agent.id));
  if (!rooms.length) return null;
  const lines = rooms.map((r) => `- #${r.name} (id: ${r.id})${r.charter ? ` — ${r.charter}` : ''}`);
  return `Group chats you are a member of:\n${lines.join('\n')}\n\nMessages from these arrive in this conversation prefixed with [Group chat #name]. Whatever you reply to one is posted back into that room automatically — you do not need to call any API to speak. @mention a member by name to hand them the next turn.`;
}

function buildFullSystemPrompt(agent) {
  // Lives in the repo (AGENTS.md), not personal memory — so it ships with
  // every install automatically instead of needing to be hand-copied into
  // each account's own memory system. Port/token path are computed per
  // install, never hardcoded, so nothing here needs editing on a new deploy.
  const selfContext = `[xqlytskg-chat context: you are agent "${agent.name}" (id: ${agent.id}) inside this chat app. Base URL: http://127.0.0.1:${PORT} — auth token is the contents of ${TOKEN_FILE_PATH}. This app's own extra features (task list, group chats, etc.) are documented in ${AGENTS_DOC_FILE} — read it when you need the details.]`;
  // Peer/room directories are baked in at spawn time, so a roster change only
  // reaches an agent when its bridge next restarts. That's why every room
  // delivery also carries its own member list inline — that copy is always
  // current, and is the one an agent should trust if the two disagree.
  return [selfContext, buildPeerDirectory(agent), buildRoomDirectory(agent), agent.systemPrompt]
    .filter(Boolean)
    .join('\n\n');
}

function startAgentBridge(agent) {
  const bridge = new ClaudeBridge({
    sessionId: agent.sessionId,
    workdir: agent.workdir,
    systemPrompt: buildFullSystemPrompt(agent),
    model: agent.model,
    effort: agent.effort,
    extraEnv: agent.provider === 'openrouter' ? openRouterEnv() : null,
  });
  bridge.configKey = bridgeConfigKey(agent);
  const runtime = {
    bridge, currentTurn: null, liveDeltaBuffer: '', turnStartedAt: null, activeToolName: null,
    interrupted: false, waitingUntil: null, lastUserText: null, retryTimeoutId: null, slashCommands: [],
    // Inbound messages that arrived while this agent was mid-turn. Without
    // this they'd go straight down the CLI's stdin on top of a turn already
    // in flight — fine for one human typing, not fine once several agents can
    // address the same agent at once.
    queue: [],
    replyTo: null,   // roomId whose delivery started the in-flight turn, if any
    replyHops: 0,    // how far down an agent→agent chain that delivery already was
    usageProbe: 0, // counter: number of pending probe commands (usage, context, etc.)
    compacting: null, // { startedAt, tokensBefore } while a /compact is in flight
    compactedAt: null, // carries the finished compaction until the after-probe lands
    clearing: null, // { startedAt, tokensBefore } while a /clear is in flight
    clearedAt: null, // carries the finished clear until the after-probe lands
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
    // Context window fill is per-session, not account-wide like session/week
    // (each agent is a separate --resume'd conversation against its own
    // context window) — it must live here, per-runtime, not in the single
    // global `latestUsage`. Storing it globally was the bug behind every
    // agent's context bar showing whichever agent was last probed,
    // regardless of which chat was actually open.
    latestContext: null, // { percent, detail, tokensUsed, tokensTotal, updatedAt } | null
  };
  runtimes.set(agent.id, runtime);

  bridge.on('ready', ({ sessionId, slashCommands }) => {
    store.setAgentSessionId(agent.id, sessionId);
    runtime.slashCommands = slashCommands || [];
    broadcastRosterEntry(agent.id);
    // A room message that arrived while this process was starting (or
    // restarting after a crash) has been sitting in the queue with nothing to
    // send it — this is the point at which stdin exists again.
    flushQueue(agent.id);
  });

  bridge.on('delta', (text) => {
    // Invisible background probes (/usage, /context) run the bridge through
    // a real turn under the hood, and their turn_done is already suppressed
    // from becoming a visible message — but that suppression happens too
    // late to stop *these* live events, which fire the moment the model
    // starts responding. Without this guard, a probe that happens to
    // stream/think/call a tool (plausible for any reasoning-capable model,
    // and probes fire after every real reply) shows a phantom live bubble
    // that has nothing to do with anything the user actually asked for.
    if (runtime.usageProbe > 0) return;
    runtime.liveDeltaBuffer += text;
    broadcast({ type: 'delta', agentId: agent.id, text });
  });

  bridge.on('thinking_start', () => {
    if (runtime.usageProbe > 0) return;
    runtime.liveThinkingText = '';
    runtime.liveThinkingTokens = 0;
    broadcast({ type: 'thinking_start', agentId: agent.id });
  });

  bridge.on('thinking_delta', ({ text, estimatedTokens }) => {
    if (runtime.usageProbe > 0) return;
    if (text) runtime.liveThinkingText += text;
    if (estimatedTokens) runtime.liveThinkingTokens += estimatedTokens;
    broadcast({ type: 'thinking_delta', agentId: agent.id, text, tokens: runtime.liveThinkingTokens });
  });

  bridge.on('thinking_final', ({ text }) => {
    if (runtime.usageProbe > 0) return;
    // The CLI's own final block is authoritative over whatever was
    // accumulated from deltas — covers cases where a delta was missed, and
    // is a no-op when the two already agree.
    runtime.liveThinkingText = text;
  });

  bridge.on('tool_use', ({ id, name, input }) => {
    if (runtime.usageProbe > 0) return;
    if (!runtime.currentTurn) runtime.currentTurn = { tools: [] };
    runtime.currentTurn.tools.push({ id, name, input, result: null, isError: false });
    runtime.activeToolName = name;
    broadcast({ type: 'tool_use', agentId: agent.id, id, name, input });
    broadcastRosterEntry(agent.id);
  });

  bridge.on('tool_result', ({ toolUseId, isError, content }) => {
    if (runtime.usageProbe > 0) return;
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
      // session/week are genuinely account-wide (same figures no matter which
      // agent's bridge happens to ask) so they stay in the single global
      // latestUsage. context is per-agent-session — each agent is a separate
      // --resume'd conversation with its own context window — so it's kept
      // on this runtime instead, and broadcast with the agentId a client
      // needs to know whether it actually applies to the chat it has open.
      if (runtime._probeUsage) {
        latestUsage = { ...latestUsage, ...runtime._probeUsage, updatedAt: Date.now() };
        broadcast({ type: 'usage_update', usage: latestUsage });
      }
      if (runtime._probeContext) {
        runtime.latestContext = { ...runtime._probeContext, updatedAt: Date.now() };
        broadcast({ type: 'context_update', agentId: agent.id, context: runtime.latestContext });
      }

      // This probe was the one kicked off right after a /compact finished, so
      // its context reading is the "after" figure — pair it with the "before"
      // captured at send time to report a real, measured token delta.
      const done = runtime.compactedAt;
      if (done) {
        runtime.compactedAt = null;
        const compactMessage = {
          id: randomUUID(),
          role: 'compact-summary',
          ts: Date.now(),
          tokensBefore: done.tokensBefore,
          tokensAfter: runtime._probeContext?.tokensUsed ?? null,
          percentAfter: runtime._probeContext?.percent ?? null,
          durationMs: done.durationMs,
          wasInterrupted: done.wasInterrupted,
          isError: done.isError,
        };
        // Persisted (not just broadcast) so the marker survives a reload or
        // reopen — otherwise the only record that a compaction happened was
        // this one live WS event, gone the moment the page refreshes.
        store.addMessage(agent.id, compactMessage);
        broadcast({ type: 'compact_done', agentId: agent.id, ...compactMessage });
      }

      // Same idea, for a /clear that just finished — see the /compact block
      // above for why this waits on the probe instead of computing it inline.
      const doneClear = runtime.clearedAt;
      if (doneClear) {
        runtime.clearedAt = null;
        const clearMessage = {
          id: randomUUID(),
          role: 'clear-summary',
          ts: Date.now(),
          tokensBefore: doneClear.tokensBefore,
          tokensAfter: runtime._probeContext?.tokensUsed ?? null,
          percentAfter: runtime._probeContext?.percent ?? null,
          durationMs: doneClear.durationMs,
          wasInterrupted: doneClear.wasInterrupted,
          isError: doneClear.isError,
        };
        store.addMessage(agent.id, clearMessage);
        broadcast({ type: 'clear_done', agentId: agent.id, ...clearMessage });
      }

      delete runtime._probeUsage;
      delete runtime._probeContext;
      broadcastRosterEntry(agent.id); // clears the brief working-indicator state
      flushQueue(agent.id); // a room message may have landed behind this probe
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
        //
        // replyTo rides along with lastUserText: the retry hours later resends
        // that same text, and without persisting where the answer belongs, a
        // server restart during the wait (routine here) would land the reply
        // in the agent's DM instead of the room it was actually answering.
        store.updateAgent(agent.id, {
          waitingUntil: runtime.waitingUntil,
          lastUserText: runtime.lastUserText,
          replyTo: runtime.replyTo || null,
          replyHops: runtime.replyHops || 0,
        });
        broadcast({ type: 'waiting', agentId: agent.id, resumesAt: runtime.waitingUntil });
        broadcastRosterEntry(agent.id);
        scheduleRetry(agent.id, resetAt);

        // The room otherwise just goes silent mid-discussion with no
        // explanation, and stays that way for hours.
        if (runtime.replyTo) {
          const room = store.getRoom(runtime.replyTo);
          if (room) {
            const note = store.addRoomMessage(room.id, {
              id: randomUUID(),
              role: 'system',
              agentId: null,
              text: `${agent.name} hit its usage limit — it will answer automatically when the limit resets at ${new Date(runtime.waitingUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`,
              ts: Date.now(),
              hops: 0,
            });
            broadcast({ type: 'room_message', roomId: room.id, message: note });
            broadcastRoomEntry(room.id);
          }
        }
        return;
      }
    }

    const finalText = wasInterrupted ? (runtime.liveDeltaBuffer || '_Stopped before responding._') : text;

    const clearing = runtime.clearing;
    runtime.clearing = null;

    // /clear's own reply is normally empty — that's the "blank speech bubble"
    // this was otherwise producing — so skip it and let the clear-summary
    // marker below (once the after-probe lands) be the only visible trace.
    // A non-empty reply (error text, interrupted-turn placeholder) still gets
    // shown normally, same as /compact.
    // This turn was started by a group-chat delivery, so the reply belongs to
    // that room rather than to the DM. Cleared before the await below so a
    // reply that itself triggers another delivery can't inherit this one.
    const replyTo = runtime.replyTo;
    const replyHops = runtime.replyHops || 0;
    runtime.replyTo = null;
    runtime.replyHops = 0;

    if (!clearing || finalText.trim()) {
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
      if (replyTo && store.getRoom(replyTo) && !isError && !wasInterrupted && finalText.trim()) {
        // Posted to the room, not to the DM — with a compact marker left in the
        // DM so this agent's own chat still shows that it was busy and where
        // the work went, instead of an unexplained gap in its history.
        const room = store.getRoom(replyTo);
        const marker = {
          id: randomUUID(),
          role: 'room-ref',
          text: `Replied in #${room.name}`,
          roomId: room.id,
          roomName: room.name,
          roomEmoji: room.emoji,
          preview: finalText.slice(0, 140),
          ts: Date.now(),
        };
        store.addMessage(agent.id, marker);
        broadcast({ type: 'assistant_message', agentId: agent.id, message: marker });
        const posted = await postRoomMessage(room, { agentId: agent.id, text: finalText, hops: replyHops });
        // Marked read only once its own reply exists and has a seq — that
        // reply is already in this agent's session, and without this its next
        // delivery would quote its own words back to it as "new in this room".
        if (posted) store.setRoomSeen(room.id, agent.id, posted.seq);
      } else {
        store.addMessage(agent.id, message);
        broadcast({ type: 'assistant_message', agentId: agent.id, message });
      }
    }

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
    // Anything that arrived while this turn was running goes now, before
    // refreshUsage below can claim the newly-idle bridge for a probe.
    flushQueue(agent.id);

    if (compacting) {
      runtime.compactedAt = {
        tokensBefore: compacting.tokensBefore,
        durationMs: Date.now() - compacting.startedAt,
        wasInterrupted,
        isError: !wasInterrupted && isError,
      };
    }
    if (clearing) {
      runtime.clearedAt = {
        tokensBefore: clearing.tokensBefore,
        durationMs: Date.now() - clearing.startedAt,
        wasInterrupted,
        isError: !wasInterrupted && isError,
      };
    }
    refreshUsage(agent.id); // a real turn just spent tokens — the numbers may have moved

    // A reply that went to a room already got its own notification decision in
    // postRoomMessage — pushing again here would double-notify for one message.
    if (!wasInterrupted && !replyTo && !anyClientViewing(agent.id)) {
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
    // Same reasoning, for a /clear that died mid-flight.
    runtime.clearing = null;
    runtime.clearedAt = null;
    // The turn that died was the one owing a room a reply. Nothing will ever
    // produce that reply now, so drop the routing rather than letting the next
    // unrelated DM answer get posted into the room in its place.
    runtime.replyTo = null;
    runtime.replyHops = 0;
    broadcast({ type: 'compact_done', agentId: agent.id, crashed: true });
    broadcast({ type: 'clear_done', agentId: agent.id, crashed: true });
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
    // Restored with the rest of the wait, so the retry's answer still goes to
    // the room that asked rather than to this agent's DM.
    runtime.replyTo = agent.replyTo || null;
    runtime.replyHops = agent.replyHops || 0;
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

// ---- Group chats ----------------------------------------------------------
// A room has no process of its own. Every member keeps the single session it
// already had, so an agent in a room still remembers what it did in its DM and
// vice versa — the whole reason agents step on each other's work is context
// living in separate places, and a second session per room would just recreate
// that one level down.
//
// Delivery is addressed, never broadcast: only @mentioned members are handed a
// turn. Everyone else has the message folded into their *next* turn as
// catch-up (see store.getRoomSeen), so the room stays in sync without N agents
// waking up and replying to every line.

// High enough that a genuine back-and-forth runs to its natural end — the
// point of a room is that agents work a problem out between themselves, which
// takes more than a couple of exchanges. This is a runaway guard against two
// agents thanking each other forever, not a discussion budget.
const HOP_LIMIT = 12;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An agent reading a member list rendered as "🍳 server-chat UI" will very
// reasonably write "@🍳 server-chat UI" — observed on the first real run,
// where that mention silently resolved to nobody. Tolerating an emoji (and
// any spacing) between the @ and the name is much cheaper than trying to
// train every agent out of the habit.
const AT_PREFIX = '@(?:[\\p{Extended_Pictographic}\\p{Emoji_Component}\\uFE0F\\u200D]+\\s*)?';

// Matches @Name / @NameNoSpaces / @id against the room's actual membership.
// Longest name first, so "@NEO" inside a room that also has a "NEO - Cyber
// Security" resolves to the longer, more specific one rather than whichever
// happened to be stored first.
function parseMentions(text, members) {
  const found = [];
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    for (const variant of [m.name, m.name.replace(/\s+/g, ''), m.id]) {
      if (new RegExp(AT_PREFIX + escapeRe(variant) + '(?![\\w-])', 'iu').test(text)) {
        found.push(m.id);
        break;
      }
    }
  }
  return [...new Set(found)];
}

function roomMemberAgents(room) {
  return room.memberIds.map((id) => store.getAgent(id)).filter(Boolean);
}

function roomSenderName(msg) {
  if (!msg.agentId) return 'Human';
  return store.getAgent(msg.agentId)?.name || 'a removed agent';
}

// The text an addressed agent actually receives. Carries the member list and
// charter inline on every delivery rather than relying on the system prompt
// copy, which is frozen at spawn time and goes stale the moment membership
// changes.
function buildRoomDelivery(room, agent, catchUp) {
  // Names are written with the @ already attached so the mention token is
  // unambiguous — listing "🍳 server-chat UI" instead invites "@🍳 server-chat
  // UI", where the emoji is inside the mention.
  const members = roomMemberAgents(room)
    .map((a) => `- ${a.emoji || '🤖'} @${a.name}${a.id === agent.id ? ' (you)' : ''}${a.blurb ? ` — ${a.blurb}` : ''}`)
    .join('\n');
  const transcript = catchUp
    .map((m) => (m.role === 'system' ? `[${m.text}]` : `${roomSenderName(m)}: ${m.text}`))
    .join('\n\n');

  return [
    `[Group chat #${room.name}]`,
    room.charter ? `Purpose of this room: ${room.charter}` : null,
    `Members:\n${members}`,
    `--- new in this room since you last spoke ---\n${transcript}\n--- end ---`,
    `You were @mentioned. Your next reply is posted into #${room.name} automatically — write it as a message to the room, not as a report to one person, and keep it short enough for others to read quickly. To hand someone the next turn, @mention them by name; if the discussion has reached its end, reply without mentioning anyone.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function anyClientViewingRoom(roomId) {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.isVisible && ws.openRoomId === roomId) return true;
  }
  return false;
}

function roomEntry(room) {
  const messages = store.getRoomMessages(room.id);
  const last = messages[messages.length - 1] || null;
  const members = roomMemberAgents(room);
  return {
    kind: 'room',
    id: room.id,
    name: room.name,
    emoji: room.emoji,
    color: room.color,
    charter: room.charter,
    memberIds: room.memberIds,
    members: members.map((a) => ({
      id: a.id, name: a.name, emoji: a.emoji, color: a.color, blurb: a.blurb || null,
    })),
    unreadCount: store.getRoomUnread(room.id),
    lastMessage: last ? { text: last.text, ts: last.ts, sender: roomSenderName(last) } : null,
    // Who in this room is mid-turn right now — drives the "3 agents thinking"
    // cue, which is the only way to tell a live discussion from a stalled one.
    // A rate-limited member is excluded: it keeps turnStartedAt set for the
    // whole wait, so counting it as busy would show "replying…" for hours.
    busyMemberIds: members
      .filter((a) => isReallyWorking(runtimes.get(a.id)) && !runtimes.get(a.id)?.waitingUntil)
      .map((a) => a.id),
    waitingMemberIds: members
      .filter((a) => runtimes.get(a.id)?.waitingUntil)
      .map((a) => ({ id: a.id, resumesAt: runtimes.get(a.id).waitingUntil })),
    // Members carrying room context they haven't had a turn on yet.
    pendingMemberIds: members
      .filter((a) => store.getRoomSeen(room.id, a.id) < (last?.seq || 0))
      .map((a) => a.id),
  };
}

function buildRooms() {
  return store.listRooms().map(roomEntry);
}

function broadcastRoomEntry(roomId) {
  const room = store.getRoom(roomId);
  if (room) broadcast({ type: 'room_entry', room: roomEntry(room) });
}

// Wakes a sleeping agent the same way a human message does — a --resume, no
// different from any other first message after an idle period.
function ensureRuntime(agentId) {
  let runtime = runtimes.get(agentId);
  if (!runtime) {
    const agent = store.getAgent(agentId);
    if (!agent) return null;
    runtime = startAgentBridge(agent);
    broadcastRosterEntry(agentId);
  }
  return runtime;
}

function enqueueForAgent(agentId, item) {
  const runtime = ensureRuntime(agentId);
  if (!runtime) return;
  runtime.queue.push(item);
  flushQueue(agentId);
}

// Sends the next queued item, coalescing every consecutive item bound for the
// same room into one delivery: three things said to an agent while it was busy
// should cost it one turn that reads all three, not three turns that each
// answer a message the others already moved past.
function flushQueue(agentId) {
  const runtime = runtimes.get(agentId);
  if (!runtime || runtime.turnStartedAt || !runtime.queue.length) return;

  const { replyTo } = runtime.queue[0];
  const group = [];
  while (runtime.queue.length && runtime.queue[0].replyTo === replyTo) {
    group.push(runtime.queue.shift());
  }
  const text = group.map((g) => g.text).join('\n\n');

  try {
    runtime.bridge.send(text);
    runtime.lastUserText = text;
    runtime.replyTo = replyTo;
    runtime.replyHops = Math.max(...group.map((g) => g.hops || 0));
    runtime.turnStartedAt = Date.now();
    runtime.activeToolName = null;
    broadcast({ type: 'turn_started', agentId });
    broadcastRosterEntry(agentId);
  } catch (err) {
    broadcast({ type: 'system', agentId, text: `group-chat delivery failed: ${err.message}` });
  }
}

// Brings one member up to date and gives it the turn.
function deliverRoomTo(room, agentId, hops) {
  const agent = store.getAgent(agentId);
  if (!agent) return;
  const all = store.getRoomMessages(room.id);
  const seen = store.getRoomSeen(room.id, agentId);
  const catchUp = all.filter((m) => m.seq > seen);
  // Already caught up means another delivery is carrying this same content and
  // that agent's turn on it is already queued — a second identical delivery
  // would just make it answer twice.
  if (!catchUp.length) return;
  store.setRoomSeen(room.id, agentId, all[all.length - 1].seq);
  enqueueForAgent(agentId, { text: buildRoomDelivery(room, agent, catchUp), replyTo: room.id, hops });
}

// The single path every room message goes through, whoever sent it: the human
// from the composer, an agent's auto-routed reply, or an agent POSTing to the
// API directly.
async function postRoomMessage(room, { agentId = null, text, hops = 0 }) {
  const message = store.addRoomMessage(room.id, {
    id: randomUUID(),
    role: agentId ? 'agent' : 'user',
    agentId,
    text,
    ts: Date.now(),
    hops,
  });
  broadcast({ type: 'room_message', roomId: room.id, message });

  const members = roomMemberAgents(room);
  let mentions = parseMentions(text, members).filter((id) => id !== agentId);

  if (hops >= HOP_LIMIT && mentions.length) {
    mentions = [];
    const note = store.addRoomMessage(room.id, {
      id: randomUUID(),
      role: 'system',
      agentId: null,
      text: `Chain limit reached (${HOP_LIMIT} hops without you) — mentions above were not delivered. @mention someone to pick it back up.`,
      ts: Date.now(),
      hops: 0,
    });
    broadcast({ type: 'room_message', roomId: room.id, message: note });
  }

  for (const id of mentions) deliverRoomTo(room, id, hops + 1);
  broadcastRoomEntry(room.id);

  // Notify only when an agent said something that hands the thread back to
  // you — i.e. it mentioned nobody, so the discussion has come to rest. A push
  // per message would fire on every line of an agent-to-agent exchange, which
  // is exactly the noise this feature exists to save you from.
  if (agentId && !mentions.length && !anyClientViewingRoom(room.id)) {
    store.incrementRoomUnread(room.id);
    broadcastRoomEntry(room.id);
    const sender = store.getAgent(agentId);
    await sendPush({
      title: `${room.emoji || '👥'} ${room.name}`,
      body: `${sender?.name || 'Agent'}: ${text.slice(0, 160)}`,
      unread: totalUnread(),
      roomId: room.id,
    });
  }
  return message;
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
    // The persisted copies exist only to survive a restart *during the wait*.
    // The wait is over; runtime.replyTo (still set) carries the routing for
    // the turn now in flight, and leaving a stale copy on disk would misroute
    // some unrelated later reply into the room.
    store.updateAgent(agentId, { waitingUntil: null, replyTo: null, replyHops: 0 });
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

// ---- Idle sleep: an agent nobody has messaged in a day is pure idle
// memory (~200MB+ per resident `claude` process) for no benefit — waking
// it back up on the next message is just a normal --resume, so there's no
// real cost to letting it go to sleep in between. ----
const IDLE_SLEEP_MS = 24 * 60 * 60 * 1000;

// Sleep state otherwise lives only in the `runtimes` map (absence = asleep),
// which a restart wipes clean — without this check every agent, including
// ones that had been asleep for weeks, would come back resident the moment
// the process restarts, defeating the whole point of idle sleep. An agent
// mid-wait for a session-limit reset always starts anyway so that retry
// isn't lost (see the waitingUntil handling inside startAgentBridge).
for (const agent of store.listAgents()) {
  const idle = !agent.waitingUntil && Date.now() - lastActivityTs(agent.id) > IDLE_SLEEP_MS;
  if (!idle) startAgentBridge(agent);
}

setInterval(() => {
  const now = Date.now();
  for (const [agentId, runtime] of runtimes) {
    if (runtime.turnStartedAt) continue; // never sleep mid-turn
    if (runtime.queue.length) continue; // ...nor holding an undelivered room message
    if (now - lastActivityTs(agentId) > IDLE_SLEEP_MS) {
      stopAgentBridge(agentId);
      broadcastRosterEntry(agentId);
    }
  }
}, 60 * 60 * 1000); // hourly check is plenty coarse for a ~24h threshold

// ---- Usage tracking: the CLI doesn't push this proactively, so we ask via
// an invisible `/usage` + `/context` probe whenever the numbers could
// plausibly have changed (see the two call sites below). The probe is
// invisible (handled specially in turn_done), so it won't flicker a stray
// "Thinking…" into view. session/week are account-wide and stored globally
// here; context is per-agent-session and stored on each runtime instead
// (runtime.latestContext) — folding it into this global was the bug behind
// every agent's context bar showing whichever agent was probed last.
let latestUsage = null; // { session: {...}|null, week: {...}|null, updatedAt }

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
    if (runtime.queue.length) continue; // about to take a real turn — don't delay it behind a probe
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
  res.json({ agents: buildRoster(), rooms: buildRooms(), vapidPublicKey: VAPID_PUBLIC_KEY, usage: latestUsage });
});

// ---- Room API. Agents use these to see who they're in a room with and to
// start a thread of their own; replying to a delivery needs none of this,
// since that reply is routed back automatically. ----

app.get('/api/rooms', requireAuth, (req, res) => {
  res.json({ rooms: buildRooms() });
});

app.get('/api/rooms/:id', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'no such room' });
  res.json({ room: roomEntry(room) });
});

app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'no such room' });
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const all = store.getRoomMessages(room.id);
  const messages = all.slice(-limit).map((m) => ({ ...m, sender: roomSenderName(m) }));
  res.json({ messages, hasMore: all.length > messages.length, totalCount: all.length });
});

app.post('/api/rooms/:id/messages', requireAuth, async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'no such room' });
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });

  // Omitting agentId posts as the human — which is what a script or a curl
  // from outside any agent should look like.
  const agentId = typeof req.body.agentId === 'string' ? req.body.agentId : null;
  if (agentId && !room.memberIds.includes(agentId)) {
    return res.status(403).json({ error: 'not a member of this room' });
  }
  const message = await postRoomMessage(room, { agentId, text, hops: 0 });
  res.json({ message });
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name, emoji, color, charter, memberIds } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  const ids = Array.isArray(memberIds) ? memberIds.filter((id) => store.getAgent(id)) : [];
  const room = store.createRoom({
    name: name.trim().slice(0, 60),
    emoji: typeof emoji === 'string' && emoji.trim() ? emoji.trim().slice(0, 8) : '👥',
    color: typeof color === 'string' && color ? color : '#7c9cff',
    charter: typeof charter === 'string' && charter.trim() ? charter.trim().slice(0, 2000) : null,
    memberIds: ids,
  });
  // Membership is part of every member's system prompt, so a running bridge
  // holds a stale copy until it restarts. Each delivery carries the current
  // list inline, so this is a nicety rather than a correctness fix.
  broadcastRoomEntry(room.id);
  res.json({ room: roomEntry(room) });
});

app.patch('/api/rooms/:id', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'no such room' });
  const body = req.body || {};
  const patch = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
  if (typeof body.emoji === 'string' && body.emoji.trim()) patch.emoji = body.emoji.trim().slice(0, 8);
  if (typeof body.color === 'string' && body.color) patch.color = body.color;
  if (typeof body.charter === 'string') patch.charter = body.charter.trim() ? body.charter.trim().slice(0, 2000) : null;
  if (Array.isArray(body.memberIds)) patch.memberIds = body.memberIds.filter((id) => store.getAgent(id));
  const updated = store.updateRoom(room.id, patch);
  broadcastRoomEntry(room.id);
  res.json({ room: roomEntry(updated) });
});

app.delete('/api/rooms/:id', requireAuth, (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'no such room' });
  store.removeRoom(room.id);
  broadcast({ type: 'room_removed', roomId: room.id });
  res.json({ ok: true });
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
    working: isReallyWorking(runtime) ? liveTurnState(runtime) : null,
    compacting: runtime?.compacting ? { startedAt: runtime.compacting.startedAt } : null,
    context: runtime?.latestContext || null,
  });
});

function broadcastTodos(agentId) {
  broadcast({ type: 'todos_update', agentId, todos: store.getTodos(agentId) });
  // Also refresh the roster entry so the list-view open-task badge updates
  // live, without requiring the agent's own chat/todo panel to be open.
  broadcastRosterEntry(agentId);
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
  const { name, emoji, color, workdir, systemPrompt, model, provider, blurb } = req.body || {};
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
    systemPrompt: typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt.trim().slice(0, PERSONA_MAX_CHARS) : null,
    blurb: typeof blurb === 'string' && blurb.trim() ? blurb.trim().slice(0, BLURB_MAX_CHARS) : null,
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
    const sp = body.systemPrompt.trim() ? body.systemPrompt.trim().slice(0, PERSONA_MAX_CHARS) : null;
    if (sp !== agent.systemPrompt) {
      patch.systemPrompt = sp;
      bridgeParamsChanged = true;
    }
  }
  // Not a bridge restart: the blurb describes this agent to *other* agents, so
  // it lands in their prompts, not this one's — and every room delivery
  // rebuilds the member list from the store anyway.
  if (typeof body.blurb === 'string') {
    patch.blurb = body.blurb.trim() ? body.blurb.trim().slice(0, BLURB_MAX_CHARS) : null;
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

  // Same lazy-restart treatment as model: persisted immediately, applied to
  // the running bridge right before the next message (see bridgeConfigKey
  // check below), never interrupting a turn in flight.
  if (body.effort !== undefined) {
    if (body.effort !== null && !VALID_EFFORTS.includes(body.effort)) {
      return res.status(400).json({ error: `effort must be one of: ${VALID_EFFORTS.join(', ')}` });
    }
    patch.effort = body.effort;
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
  // Which rooms it belonged to has to be read before the delete — removeAgent
  // strips it from their membership as part of the same call.
  const affectedRooms = store.listRooms().filter((r) => r.memberIds.includes(agent.id)).map((r) => r.id);
  stopAgentBridge(agent.id);
  store.removeAgent(agent.id);
  broadcast({ type: 'agent_removed', agentId: agent.id });
  for (const roomId of affectedRooms) broadcastRoomEntry(roomId);
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
  ws.openRoomId = null; // ...or which room's, since both use the same screen

  ws.send(JSON.stringify({ type: 'hello', agents: buildRoster(), rooms: buildRooms(), usage: latestUsage }));
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
        store.updateAgent(msg.agentId, { waitingUntil: null, replyTo: null, replyHops: 0 });
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
        // You're talking to this agent directly, so its answer belongs here —
        // never in a room whose delivery it happened to still owe a reply to
        // (e.g. one superseded by this very message while it was rate-limited).
        runtime.replyTo = null;
        runtime.replyHops = 0;
        runtime.turnStartedAt = Date.now();
        runtime.activeToolName = null;
        // /compact is slow, silent, and emits no progress of its own, so flag
        // it here to give the client something specific to show instead of a
        // generic "Thinking". The context reading taken now is the "before"
        // half of the token delta reported when it finishes.
        if (/^\/compact\b/i.test(msg.text.trim())) {
          runtime.compacting = { startedAt: Date.now(), tokensBefore: runtime.latestContext?.tokensUsed ?? null };
          broadcast({ type: 'compacting', agentId: msg.agentId, startedAt: runtime.compacting.startedAt });
        } else if (/^\/clear\b/i.test(msg.text.trim())) {
          // /clear has no progress or summary of its own — the CLI's reply is
          // typically empty — so capture the "before" reading now and report
          // the delta ourselves once the after-probe (below) lands.
          runtime.clearing = { startedAt: Date.now(), tokensBefore: runtime.latestContext?.tokensUsed ?? null };
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
        // Cancelling the retry cancels the reply it owed the room too.
        runtime.replyTo = null;
        runtime.replyHops = 0;
        store.updateAgent(msg.agentId, { waitingUntil: null, replyTo: null, replyHops: 0 });
        broadcastRosterEntry(msg.agentId);
      } else if (runtime && runtime.turnStartedAt) {
        runtime.interrupted = true;
        runtime.bridge.interrupt();
      }
    } else if (msg.type === 'room_message' && typeof msg.roomId === 'string' && typeof msg.text === 'string' && msg.text.trim()) {
      const room = store.getRoom(msg.roomId);
      if (!room) return;
      // hops 0: anything you say resets the chain, which is what makes the hop
      // limit a guard against agents looping rather than a cap on how long a
      // conversation you're part of can run.
      postRoomMessage(room, { agentId: null, text: msg.text.trim(), hops: 0 });
    } else if (msg.type === 'room_stop' && typeof msg.roomId === 'string') {
      // One button for the whole room: in a live cascade the useful action is
      // "everyone stop", not hunting down which three members are mid-turn.
      const room = store.getRoom(msg.roomId);
      if (!room) return;
      for (const agent of roomMemberAgents(room)) {
        const runtime = runtimes.get(agent.id);
        if (!runtime) continue;
        runtime.queue = [];
        if (runtime.turnStartedAt && !runtime.usageProbe) {
          runtime.interrupted = true;
          runtime.bridge.interrupt();
        }
      }
      broadcastRoomEntry(room.id);
    } else if (msg.type === 'room_view') {
      // Rooms and agent DMs share one screen, so opening either closes the
      // other — leaving both set would suppress notifications for a chat that
      // isn't actually on screen any more.
      ws.openRoomId = typeof msg.roomId === 'string' ? msg.roomId : null;
      if (ws.openRoomId) ws.openAgentId = null;
      if (ws.openRoomId && ws.isVisible) {
        store.clearRoomUnread(ws.openRoomId);
        broadcastRoomEntry(ws.openRoomId);
      }
    } else if (msg.type === 'view') {
      // Which agent's chat (if any) is currently the open screen on this
      // connection — drives per-agent unread clearing and push suppression.
      ws.openAgentId = typeof msg.agentId === 'string' ? msg.agentId : null;
      if (ws.openAgentId) ws.openRoomId = null;
      if (ws.openAgentId && ws.isVisible) {
        store.clearUnread(ws.openAgentId);
        broadcastRosterEntry(ws.openAgentId);
      }
      // Context is only ever refreshed after a real turn completes or on a
      // fresh WS connection — neither happens just from switching to a
      // different agent's chat. Without this, any agent that hasn't yet had
      // a turn complete since its bridge last started (first-ever message,
      // right after a model switch, right after a service restart) shows an
      // empty bar indefinitely: nothing else was ever going to ask for its
      // number. refreshUsage is a no-op if that agent is genuinely busy.
      if (ws.openAgentId) refreshUsage(ws.openAgentId);
    } else if (msg.type === 'visibility') {
      ws.isVisible = !!msg.visible;
      if (ws.isVisible && ws.openAgentId) {
        store.clearUnread(ws.openAgentId);
        broadcastRosterEntry(ws.openAgentId);
      }
      if (ws.isVisible && ws.openRoomId) {
        store.clearRoomUnread(ws.openRoomId);
        broadcastRoomEntry(ws.openRoomId);
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
