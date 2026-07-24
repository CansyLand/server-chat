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

app.get('/api/history', requireAuth, (req, res) => {
  res.json({
    messages: store.getMessages(),
    unreadCount: store.getUnreadCount(),
    vapidPublicKey: VAPID_PUBLIC_KEY,
  });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  store.setPushSubscription(req.body.subscription);
  res.json({ ok: true });
});

app.post('/api/read', requireAuth, (req, res) => {
  store.clearUnread();
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Claude bridge: one persistent conversation for the whole daemon ----
const bridge = new ClaudeBridge({ sessionId: store.sessionId });

let currentAssistantTurn = null; // { tools: [] }
let liveDeltaBuffer = '';

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function anyClientVisible() {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.isVisible) return true;
  }
  return false;
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

bridge.on('ready', ({ sessionId }) => {
  store.setSessionId(sessionId);
});

bridge.on('delta', (text) => {
  liveDeltaBuffer += text;
  broadcast({ type: 'delta', text });
});

bridge.on('tool_use', ({ id, name, input }) => {
  if (!currentAssistantTurn) currentAssistantTurn = { tools: [] };
  currentAssistantTurn.tools.push({ id, name, input, result: null, isError: false });
  broadcast({ type: 'tool_use', id, name, input });
});

bridge.on('tool_result', ({ toolUseId, isError, content }) => {
  if (!currentAssistantTurn) currentAssistantTurn = { tools: [] };
  const tool = currentAssistantTurn.tools.find((t) => t.id === toolUseId);
  const preview = toolResultPreview(content);
  if (tool) {
    tool.result = preview;
    tool.isError = isError;
  }
  broadcast({ type: 'tool_result', toolUseId, isError, preview });
});

bridge.on('turn_done', async ({ text, isError }) => {
  const message = {
    id: randomUUID(),
    role: 'assistant',
    text,
    ts: Date.now(),
    isError,
    tools: currentAssistantTurn?.tools || [],
  };
  store.addMessage(message);
  broadcast({ type: 'assistant_message', message });

  currentAssistantTurn = null;
  liveDeltaBuffer = '';

  if (!anyClientVisible()) {
    const unread = store.incrementUnread();
    await sendPush({
      title: 'Claude',
      body: text.slice(0, 180) || 'New response',
      unread,
    });
  }
});

bridge.on('crash', () => {
  broadcast({ type: 'system', text: 'claude process restarting…' });
});

bridge.on('stderr', (text) => {
  console.error('[claude stderr]', text.trim());
});

bridge.start();

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

  ws.send(JSON.stringify({
    type: 'hello',
    messages: store.getMessages(),
    unreadCount: store.getUnreadCount(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'message' && typeof msg.text === 'string' && msg.text.trim()) {
      const userMessage = {
        id: randomUUID(),
        role: 'user',
        text: msg.text,
        ts: Date.now(),
      };
      store.addMessage(userMessage);
      broadcast({ type: 'user_message', message: userMessage });
      try {
        bridge.send(msg.text);
      } catch (err) {
        broadcast({ type: 'system', text: `error: ${err.message}` });
      }
    } else if (msg.type === 'visibility') {
      ws.isVisible = !!msg.visible;
      if (ws.isVisible) store.clearUnread();
    } else if (msg.type === 'read') {
      store.clearUnread();
    }
  });
});

process.on('SIGTERM', () => {
  bridge.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  bridge.stop();
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`xqlytskg-chat daemon listening on 127.0.0.1:${PORT}`);
});
