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

function rosterEntry(agent) {
  const messages = store.getMessages(agent.id);
  const last = messages[messages.length - 1] || null;
  const runtime = runtimes.get(agent.id);
  return {
    id: agent.id,
    name: agent.name,
    emoji: agent.emoji,
    color: agent.color,
    unreadCount: store.getUnreadCount(agent.id),
    lastMessage: last ? { text: last.text, role: last.role, ts: last.ts } : null,
    working: runtime?.turnStartedAt ? { startedAt: runtime.turnStartedAt, tool: runtime.activeToolName } : null,
  };
}

function buildRoster() {
  return store.listAgents().map(rosterEntry);
}

function broadcastRosterEntry(agentId) {
  const agent = store.getAgent(agentId);
  if (agent) broadcast({ type: 'roster_entry', agent: rosterEntry(agent) });
}

function startAgentBridge(agent) {
  const bridge = new ClaudeBridge({
    sessionId: agent.sessionId,
    workdir: agent.workdir,
    systemPrompt: agent.systemPrompt,
  });
  const runtime = { bridge, currentTurn: null, liveDeltaBuffer: '', turnStartedAt: null, activeToolName: null };
  runtimes.set(agent.id, runtime);

  bridge.on('ready', ({ sessionId }) => {
    store.setAgentSessionId(agent.id, sessionId);
  });

  bridge.on('delta', (text) => {
    runtime.liveDeltaBuffer += text;
    broadcast({ type: 'delta', agentId: agent.id, text });
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
    const message = {
      id: randomUUID(),
      role: 'assistant',
      text,
      ts: Date.now(),
      isError,
      tools: runtime.currentTurn?.tools || [],
    };
    store.addMessage(agent.id, message);
    broadcast({ type: 'assistant_message', agentId: agent.id, message });

    runtime.currentTurn = null;
    runtime.liveDeltaBuffer = '';
    runtime.turnStartedAt = null;
    runtime.activeToolName = null;
    broadcastRosterEntry(agent.id);

    if (!anyClientViewing(agent.id)) {
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
    runtime.turnStartedAt = null;
    runtime.activeToolName = null;
    broadcast({ type: 'system', agentId: agent.id, text: `${agent.name}: process restarting…` });
    broadcastRosterEntry(agent.id);
  });

  bridge.on('stderr', (text) => {
    console.error(`[claude stderr:${agent.id}]`, text.trim());
  });

  bridge.start();
  return runtime;
}

for (const agent of store.listAgents()) startAgentBridge(agent);

app.get('/api/roster', requireAuth, (req, res) => {
  res.json({ agents: buildRoster(), vapidPublicKey: VAPID_PUBLIC_KEY });
});

app.get('/api/agents/:id/messages', requireAuth, (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const runtime = runtimes.get(agent.id);
  res.json({
    messages: store.getMessages(agent.id),
    working: runtime?.turnStartedAt ? { startedAt: runtime.turnStartedAt, tool: runtime.activeToolName } : null,
  });
});

app.post('/api/agents', requireAuth, (req, res) => {
  const { name, emoji, color, workdir, systemPrompt } = req.body || {};
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

  const agent = store.createAgent({
    name: name.trim().slice(0, 60),
    emoji: emoji.trim().slice(0, 8),
    color: typeof color === 'string' && color ? color : '#7c9cff',
    workdir: dir,
    systemPrompt: typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt.trim().slice(0, 4000) : null,
  });
  startAgentBridge(agent);
  broadcast({ type: 'roster_entry', agent: rosterEntry(agent) });
  res.json({ agent: rosterEntry(agent) });
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

  ws.send(JSON.stringify({ type: 'hello', agents: buildRoster() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'message' && typeof msg.agentId === 'string' && typeof msg.text === 'string' && msg.text.trim()) {
      const runtime = runtimes.get(msg.agentId);
      if (!runtime) return;
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
        runtime.turnStartedAt = Date.now();
        runtime.activeToolName = null;
        broadcastRosterEntry(msg.agentId);
      } catch (err) {
        broadcast({ type: 'system', agentId: msg.agentId, text: `error: ${err.message}` });
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
