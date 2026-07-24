const $ = (sel) => document.querySelector(sel);
const listViewEl = $('#list-view');
const agentListEl = $('#agent-list');
const chatViewEl = $('#chat-view');
const messagesEl = $('#messages');
const chatAgentEmojiEl = $('#chat-agent-emoji');
const chatAgentNameEl = $('#chat-agent-name');
const backBtn = $('#back-btn');
const newAgentBtn = $('#new-agent-btn');
const newAgentModal = $('#new-agent-modal');
const newAgentForm = $('#new-agent-form');
const newAgentNameInput = $('#new-agent-name');
const newAgentWorkdirInput = $('#new-agent-workdir');
const newAgentPersonaInput = $('#new-agent-persona');
const newAgentErrorEl = $('#new-agent-error');
const newAgentSubmitBtn = $('#new-agent-submit');
const newAgentCancelBtn = $('#new-agent-cancel');
const emojiPickerEl = $('#emoji-picker');
const formEl = $('#composer');
const inputEl = $('#input');
const statusEl = $('#status');
const notifyBtn = $('#notify-btn');
const gateEl = $('#gate');
const appEl = $('#app');
const gateBoxEl = $('#gate-box');
const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsVersionEl = $('#settings-version');
const settingsUpdateBtn = $('#settings-update-btn');
const settingsCloseBtn = $('#settings-close-btn');

// A new service worker taking over mid-session means a fresh deploy just
// landed; reload once so the page picks it up immediately instead of the
// user having to force-quit and relaunch to see changes.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
}

const TOKEN_KEY = 'xqlytskg_token';
let currentToken = null;

// Theme is applied synchronously in index.html (before this script runs) to
// avoid a flash of the default profile; this map just keeps the PWA status
// bar / browser-chrome color (the <meta name="theme-color"> tag) in sync
// with whichever profile is active, since that can't be done in CSS alone.
const THEME_KEY = 'xqlytskg_theme';
const THEME_BG = {
  indigo: '#0b0b0d',
  emerald: '#0a0d0c',
  amber: '#0d0b09',
  rose: '#0d0a0c',
  teal: '#0a0d0d',
  violet: '#0c0a0d',
};

function applyTheme(theme) {
  const t = THEME_BG[theme] ? theme : 'indigo';
  if (t === 'indigo') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_BG[t];
  for (const btn of document.querySelectorAll('.theme-swatch[data-theme]')) {
    btn.classList.toggle('active', btn.dataset.theme === t);
  }
}

applyTheme(localStorage.getItem(THEME_KEY));

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function getToken() {
  const hash = location.hash;
  if (hash.startsWith('#pair=')) {
    const token = decodeURIComponent(hash.slice('#pair='.length));
    localStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, '', location.pathname);
  }
  return localStorage.getItem(TOKEN_KEY);
}

const initialToken = getToken();

if (initialToken) {
  gateEl.hidden = true;
  appEl.hidden = false;
  boot(initialToken);
} else {
  gateEl.hidden = false;
  appEl.hidden = true;
  initPairingGate();
}

// By default the gate renders as an inert, generic "not found"-style page —
// deliberately unbranded so a scanner/bot that finds this subdomain (its name
// is public forever via Certificate Transparency logs) learns nothing from
// it. The real pairing form only gets built and shown, client-side, when the
// server confirms no device is paired yet (i.e. a genuine re-pair window).
// The blank state is the permanent steady state after the one legitimate
// pairing succeeds; nothing needs to be deleted to support pairing again
// later — just clear `paired` server-side and this reactivates itself.
async function initPairingGate() {
  let paired = true; // fail safe: assume paired (stay blank) if the check fails
  try {
    const res = await fetch('/api/pair-status');
    const data = await res.json();
    paired = !!data.paired;
  } catch {
    return; // stay on the generic blank page
  }

  if (paired) return; // stay on the generic blank page

  gateBoxEl.innerHTML = '';

  const heading = document.createElement('h1');
  heading.textContent = 'Pair this device';
  const message = document.createElement('p');
  message.textContent = 'Enter the one-time pairing code, then tap Pair. This can only be done once.';
  const form = document.createElement('form');
  const codeInput = document.createElement('input');
  codeInput.autocapitalize = 'characters';
  codeInput.autocomplete = 'off';
  codeInput.placeholder = 'PAIRING CODE';
  codeInput.maxLength = 12;
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Pair this device';
  const errorEl = document.createElement('p');
  errorEl.className = 'error-text';
  errorEl.hidden = true;

  form.append(codeInput, submitBtn);
  gateBoxEl.append(heading, message, form, errorEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    errorEl.hidden = true;
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        localStorage.setItem(TOKEN_KEY, data.token);
        location.reload();
        return;
      }
      if (res.status === 410) {
        gateBoxEl.innerHTML = '<p id="gate-message">Cannot GET /</p>';
        return;
      }
      errorEl.textContent = res.status === 429 ? 'Too many attempts — try again later.' : 'Incorrect code.';
      errorEl.hidden = false;
    } catch {
      errorEl.textContent = 'Network error — try again.';
      errorEl.hidden = false;
    }
  });
}

async function boot(token) {
  currentToken = token;
  let vapidPublicKey = null;
  try {
    const res = await fetch('/api/roster', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      // A single rejected request is not proof the token is permanently
      // dead (it could be a transient server hiccup) — never delete a
      // stored token on our own say-so. The WS layer below is the
      // authoritative, continuously-retried check.
      setStatus('auth error — retrying…', false);
      showAuthWarning();
    } else {
      const data = await res.json();
      vapidPublicKey = data.vapidPublicKey;
      for (const agent of data.agents) roster.set(agent.id, agent);
      renderAgentList();
      setBadgeLocal(totalUnreadFromRoster());
    }
  } catch (err) {
    setStatus('offline — retrying…', false);
  }

  connectSocket(token);
  setupNotifications(token, vapidPublicKey);
  setupVisibility(token);
  setupSettings(token);
  setupNewAgent(token);
  setupNav();
}

// ---- Agent list (the landing screen) ----
const roster = new Map(); // agentId -> roster entry from the server
let currentAgentId = null; // which agent's chat is open; null = list view

function totalUnreadFromRoster() {
  let sum = 0;
  for (const entry of roster.values()) sum += entry.unreadCount || 0;
  return sum;
}

function renderAgentList() {
  agentListEl.innerHTML = '';
  const entries = [...roster.values()].sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No agents yet — tap + to create one.';
    agentListEl.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    agentListEl.appendChild(buildAgentRow(entry));
  }
}

function formatPreviewTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildAgentRow(entry) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'agent-row';
  row.dataset.agentId = entry.id;

  const avatar = document.createElement('span');
  avatar.className = 'agent-avatar';
  avatar.style.setProperty('--avatar-color', entry.color || '#7c9cff');
  avatar.textContent = entry.emoji || '🤖';
  if (entry.working) {
    const dot = document.createElement('span');
    dot.className = 'agent-working-dot';
    avatar.appendChild(dot);
  }

  const body = document.createElement('span');
  body.className = 'agent-row-body';
  const nameLine = document.createElement('span');
  nameLine.className = 'agent-row-name';
  nameLine.textContent = entry.name;
  const preview = document.createElement('span');
  preview.className = 'agent-row-preview';
  preview.textContent = entry.working
    ? 'Working…'
    : entry.lastMessage
      ? (entry.lastMessage.role === 'user' ? 'You: ' : '') + extractOptions(entry.lastMessage.text).cleanText.slice(0, 80)
      : 'No messages yet';
  body.append(nameLine, preview);

  const meta = document.createElement('span');
  meta.className = 'agent-row-meta';
  const time = document.createElement('span');
  time.className = 'agent-row-time';
  time.textContent = formatPreviewTime(entry.lastMessage?.ts);
  meta.appendChild(time);
  if (entry.unreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'agent-row-badge';
    badge.textContent = entry.unreadCount > 99 ? '99+' : String(entry.unreadCount);
    meta.appendChild(badge);
  }

  row.append(avatar, body, meta);
  row.addEventListener('click', () => openAgent(entry.id));
  return row;
}

function showListView() {
  currentAgentId = null;
  chatViewEl.hidden = true;
  listViewEl.hidden = false;
  resetWorkIndicatorState(); // stop the per-second timer for the chat we're leaving
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'view', agentId: null }));
  }
  renderAgentList();
}

async function openAgent(agentId) {
  const entry = roster.get(agentId);
  currentAgentId = agentId;
  chatAgentEmojiEl.textContent = entry?.emoji || '🤖';
  chatAgentNameEl.textContent = entry?.name || '';
  listViewEl.hidden = true;
  chatViewEl.hidden = false;
  messagesEl.innerHTML = '';
  resetWorkIndicatorState();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'view', agentId }));
  }

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/messages`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    const data = await res.json();
    for (const m of data.messages || []) renderMessage(m);
    scrollToBottom();
    if (data.working) startWorkIndicator(data.working.startedAt, data.working.tool);
  } catch {
    /* WS will surface connectivity issues via the list-view status line */
  }

  if (entry) {
    entry.unreadCount = 0;
    setBadgeLocal(totalUnreadFromRoster());
  }
}

function setupNav() {
  backBtn.addEventListener('click', showListView);
}

// ---- New agent creation ----
const AGENT_EMOJIS = [
  '🛠️', '🎨', '🧠', '🔬', '🧪', '📊', '💼', '📈', '🎯', '🎭', '🎬', '🎵',
  '📚', '✍️', '🍳', '🌱', '🧭', '🔐', '🚀', '🗺️', '⚖️', '🧵', '🐛', '🤖',
];
let selectedEmoji = AGENT_EMOJIS[0];
let selectedColor = '#7c9cff';

function buildEmojiPicker() {
  emojiPickerEl.innerHTML = '';
  for (const emoji of AGENT_EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-option' + (emoji === selectedEmoji ? ' active' : '');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      selectedEmoji = emoji;
      for (const b of emojiPickerEl.querySelectorAll('.emoji-option')) b.classList.toggle('active', b === btn);
    });
    emojiPickerEl.appendChild(btn);
  }
}
buildEmojiPicker();

function setupNewAgent(token) {
  newAgentBtn.addEventListener('click', () => {
    newAgentForm.reset();
    newAgentErrorEl.hidden = true;
    selectedEmoji = AGENT_EMOJIS[0];
    selectedColor = '#7c9cff';
    buildEmojiPicker();
    for (const b of document.querySelectorAll('#new-agent-colors .theme-swatch')) {
      b.classList.toggle('active', b.dataset.color === selectedColor);
    }
    newAgentModal.hidden = false;
  });

  newAgentCancelBtn.addEventListener('click', () => {
    newAgentModal.hidden = true;
  });

  newAgentModal.addEventListener('click', (e) => {
    if (e.target === newAgentModal) newAgentModal.hidden = true;
  });

  for (const btn of document.querySelectorAll('#new-agent-colors .theme-swatch')) {
    btn.addEventListener('click', () => {
      selectedColor = btn.dataset.color;
      for (const b of document.querySelectorAll('#new-agent-colors .theme-swatch')) b.classList.toggle('active', b === btn);
    });
  }

  newAgentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    newAgentErrorEl.hidden = true;
    newAgentSubmitBtn.disabled = true;
    newAgentSubmitBtn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: newAgentNameInput.value,
          emoji: selectedEmoji,
          color: selectedColor,
          workdir: newAgentWorkdirInput.value,
          systemPrompt: newAgentPersonaInput.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        newAgentErrorEl.textContent = data.error || 'Could not create agent.';
        newAgentErrorEl.hidden = false;
        return;
      }
      roster.set(data.agent.id, data.agent);
      newAgentModal.hidden = true;
      renderAgentList();
      openAgent(data.agent.id);
    } catch {
      newAgentErrorEl.textContent = 'Network error — try again.';
      newAgentErrorEl.hidden = false;
    } finally {
      newAgentSubmitBtn.disabled = false;
      newAgentSubmitBtn.textContent = 'Create agent';
    }
  });
}

// ---- Settings ----
function setupSettings(token) {
  settingsBtn.addEventListener('click', async () => {
    settingsModal.hidden = false;
    settingsVersionEl.textContent = '…';
    try {
      const res = await fetch('/api/version', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      settingsVersionEl.textContent = new Date(data.version).toLocaleString();
    } catch {
      settingsVersionEl.textContent = 'unavailable';
    }
  });

  settingsCloseBtn.addEventListener('click', () => {
    settingsModal.hidden = true;
  });

  // Tap-outside-to-close as a safety net — a modal that can only be
  // dismissed by one specific button is one CSS/JS bug away from trapping
  // the user, which is exactly what just happened.
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.hidden = true;
  });

  settingsUpdateBtn.addEventListener('click', async () => {
    settingsUpdateBtn.textContent = 'Checking…';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    } catch {
      /* ignore */
    }
    location.reload();
  });

  for (const btn of document.querySelectorAll('#theme-swatches .theme-swatch')) {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      localStorage.setItem(THEME_KEY, theme);
      applyTheme(theme);
    });
  }
}

// Rejections are shown, never acted on automatically — deleting a stored
// token on our own say-so is exactly what left a previous version of this
// app permanently stuck ("Cannot GET /" with no way back in) after what was
// probably just a transient hiccup. Only an explicit tap on "Re-pair" may
// clear it.
const authBanner = $('#auth-banner');
const authRepairBtn = $('#auth-repair-btn');

function showAuthWarning() {
  authBanner.hidden = false;
}

function hideAuthWarning() {
  authBanner.hidden = true;
}

authRepairBtn.addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

// ---- WebSocket ----
let ws = null;
let reconnectDelay = 1000;
let liveBubble = null;
let consecutiveAuthFailures = 0;

function connectSocket(token) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    setStatus('connected', true);
    reconnectDelay = 1000;
    consecutiveAuthFailures = 0;
    hideAuthWarning();
    ws.send(JSON.stringify({ type: 'visibility', visible: !document.hidden }));
    if (currentAgentId) ws.send(JSON.stringify({ type: 'view', agentId: currentAgentId }));
  };

  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      // Rejected credentials. Retry once (covers a deploy-restart race),
      // but don't hammer the server's own ban list forever on a token
      // that's genuinely dead — that just locks this IP out too.
      consecutiveAuthFailures += 1;
      showAuthWarning();
      if (consecutiveAuthFailures >= 2) {
        setStatus('not authorized', false);
        return;
      }
      setStatus('reconnecting…', false);
      setTimeout(() => connectSocket(token), reconnectDelay);
      return;
    }
    if (ev.code === 4290) {
      setStatus('rate limited — waiting…', false);
      setTimeout(() => connectSocket(token), 60000);
      return;
    }
    setStatus('reconnecting…', false);
    setTimeout(() => connectSocket(token), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 20000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerEvent(msg);
  };
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case 'hello':
      roster.clear();
      for (const agent of msg.agents) roster.set(agent.id, agent);
      if (!listViewEl.hidden) renderAgentList();
      setBadgeLocal(totalUnreadFromRoster());
      if (currentAgentId && !roster.has(currentAgentId)) showListView();
      else if (currentAgentId) {
        // Reconnect while a chat was open — resync that chat's live state
        // (e.g. the working indicator) without losing scroll/history.
        const entry = roster.get(currentAgentId);
        resetWorkIndicatorState();
        if (entry?.working) startWorkIndicator(entry.working.startedAt, entry.working.tool);
        ws.send(JSON.stringify({ type: 'view', agentId: currentAgentId }));
      }
      break;

    case 'roster_entry':
      roster.set(msg.agent.id, msg.agent);
      if (!listViewEl.hidden) renderAgentList();
      setBadgeLocal(totalUnreadFromRoster());
      break;

    case 'user_message':
      if (msg.agentId === currentAgentId) {
        if (!document.getElementById('m-' + msg.message.id)) renderMessage(msg.message);
        startWorkIndicator(msg.message.ts, null);
        scrollToBottom();
      }
      break;

    case 'delta':
      if (msg.agentId === currentAgentId) appendLiveDelta(msg.text);
      break;

    case 'tool_use':
      if (msg.agentId === currentAgentId) {
        // Full detail (name + input) is still shown, collapsed, once the
        // finished assistant_message arrives — this is just the live label.
        startWorkIndicator(workStartTs ?? Date.now(), msg.name);
      }
      break;

    case 'tool_result':
      if (msg.agentId === currentAgentId) setWorkLabel('Thinking');
      break;

    case 'assistant_message':
      if (msg.agentId === currentAgentId) {
        stopWorkIndicator();
        if (!document.getElementById('m-' + msg.message.id)) renderMessage(msg.message);
        scrollToBottom();
      }
      break;

    case 'system':
      if (msg.agentId === currentAgentId) stopWorkIndicator();
      setStatus(msg.text, false);
      break;
  }
}

let liveRawText = '';
let workStartTs = null;
let workTimerId = null;

// ---- Working indicator: mirrors the CLI's "spinner + elapsed time" cue —
// otherwise there is no signal at all that a turn is in flight until either
// streamed text or the final message shows up, which can be many seconds
// (tool calls, thinking) of apparent silence. Only ever shown for the
// currently open agent; background agents show a working-dot in the list.
function startWorkIndicator(startedAt, toolName) {
  if (!liveBubble) {
    liveBubble = document.createElement('div');
    liveBubble.className = 'msg assistant live';
    liveBubble.innerHTML = `
      <div class="bubble">
        <div class="work-status">
          <span class="work-dot"></span>
          <span class="work-label"></span>
          <span class="work-time"></span>
        </div>
        <div class="live-text"></div>
      </div>`;
    messagesEl.appendChild(liveBubble);
    liveRawText = '';
  }
  workStartTs = startedAt;
  setWorkLabel(toolName ? `Running ${toolName}` : 'Thinking');
  updateWorkTimer();
  if (!workTimerId) workTimerId = setInterval(updateWorkTimer, 1000);
  scrollToBottom();
}

function setWorkLabel(label) {
  const el = liveBubble?.querySelector('.work-label');
  if (el) el.textContent = label;
}

function updateWorkTimer() {
  const el = liveBubble?.querySelector('.work-time');
  if (!el || workStartTs == null) return;
  const secs = Math.max(0, Math.floor((Date.now() - workStartTs) / 1000));
  el.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function appendLiveDelta(text) {
  if (!liveBubble) startWorkIndicator(Date.now(), null); // defensive: delta with no preceding user_message/hello
  liveRawText += text;
  setWorkLabel('Writing');
  liveBubble.querySelector('.live-text').innerHTML = renderMarkdown(extractOptions(liveRawText).cleanText);
  scrollToBottom();
}

function stopWorkIndicator() {
  if (workTimerId) {
    clearInterval(workTimerId);
    workTimerId = null;
  }
  workStartTs = null;
  if (liveBubble) {
    liveBubble.remove();
    liveBubble = null;
  }
  liveRawText = '';
}

// Same as stopWorkIndicator, but for paths where there's no DOM to remove
// yet (messagesEl was just wiped) — only the JS state needs clearing.
function resetWorkIndicatorState() {
  if (workTimerId) {
    clearInterval(workTimerId);
    workTimerId = null;
  }
  workStartTs = null;
  liveBubble = null;
  liveRawText = '';
}

// ---- Rendering ----
// marked turns the message text into HTML; DOMPurify strips anything that
// isn't safe to inject (script tags, event-handler attributes, etc.) before
// it ever reaches innerHTML — messages are Claude's own output, but treating
// them as trusted-by-default is exactly the kind of assumption that bites
// later once e.g. tool output or pasted content flows through the same path.
function renderMarkdown(text) {
  const html = marked.parse(text ?? '', { breaks: true, gfm: true });
  return DOMPurify.sanitize(html);
}

// Quick-reply choices: a fenced ```options block, one choice per line,
// pulled out of the message before rendering and turned into tappable
// buttons instead. This is a convention Claude opts into per-message —
// there's no separate protocol message for it, it just lives in the text.
const OPTIONS_BLOCK_RE = /```options\s*\n([\s\S]*?)```/i;

function extractOptions(text) {
  const match = text.match(OPTIONS_BLOCK_RE);
  if (!match) return { cleanText: text, options: [] };
  const options = match[1]
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
  const cleanText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { cleanText, options };
}

function buildOptionButtons(options) {
  const wrap = document.createElement('div');
  wrap.className = 'option-btns';
  const buttons = options.map((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      sendMessage(opt);
      btn.classList.add('selected');
      for (const b of buttons) b.disabled = true;
    });
    wrap.appendChild(btn);
    return btn;
  });
  return wrap;
}

const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// Copies the raw message source (not the rendered HTML) so pasting
// elsewhere preserves markdown syntax — e.g. code fences — intact.
function buildCopyButton(rawText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.setAttribute('aria-label', 'Copy message');
  btn.innerHTML = COPY_ICON + '<span>Copy</span>';

  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      btn.innerHTML = CHECK_ICON + '<span>Copied</span>';
      btn.classList.add('copied');
    } catch {
      btn.innerHTML = COPY_ICON + '<span>Failed</span>';
    }
    setTimeout(() => {
      btn.innerHTML = COPY_ICON + '<span>Copy</span>';
      btn.classList.remove('copied');
    }, 1500);
  });

  return btn;
}

function renderMessage(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.id = 'm-' + m.id;

  const { cleanText, options } = extractOptions(m.text);

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (m.isError ? ' error' : '');
  bubble.innerHTML = renderMarkdown(cleanText);
  el.appendChild(bubble);

  if (options.length) el.appendChild(buildOptionButtons(options));

  el.appendChild(buildCopyButton(cleanText));

  if (m.tools && m.tools.length) {
    const details = document.createElement('details');
    details.className = 'tools';
    const summary = document.createElement('summary');
    summary.textContent = `${m.tools.length} action${m.tools.length > 1 ? 's' : ''}`;
    details.appendChild(summary);
    for (const t of m.tools) {
      const line = document.createElement('div');
      line.className = 'tool-line' + (t.isError ? ' error' : '');
      const inputPreview = t.input ? JSON.stringify(t.input).slice(0, 200) : '';
      line.textContent = `${t.name} ${inputPreview}`;
      details.appendChild(line);
    }
    el.appendChild(details);
  }

  messagesEl.appendChild(el);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', !!ok);
}

// ---- Composer ----
// Shared by the composer submit and by quick-reply option buttons — both
// are just different ways of producing the next message to the open agent.
function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN || !currentAgentId) return;
  ws.send(JSON.stringify({ type: 'message', agentId: currentAgentId, text: trimmed }));
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
  inputEl.value = '';
  inputEl.style.height = 'auto';
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

// ---- Visibility -> badge + read receipts ----
function setupVisibility(token) {
  document.addEventListener('visibilitychange', () => {
    const visible = !document.hidden;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'visibility', visible }));
    }
    if (visible) {
      setBadgeLocal(totalUnreadFromRoster());
      if (currentAgentId) {
        fetch('/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ agentId: currentAgentId }),
        }).catch(() => {});
      }
    }
  });

  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'notification-click') {
      const targetAgentId = event.data.agentId;
      if (targetAgentId && roster.has(targetAgentId)) {
        openAgent(targetAgentId);
      } else {
        setBadgeLocal(totalUnreadFromRoster());
      }
    }
  });
}

function setBadgeLocal(count) {
  if (!('setAppBadge' in navigator)) return;
  try {
    if (count > 0) navigator.setAppBadge(count);
    else navigator.clearAppBadge();
  } catch {
    /* not supported */
  }
}

// ---- Push notifications ----
async function setupNotifications(token, vapidPublicKey) {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    notifyBtn.hidden = true;
    return;
  }

  const reg = await navigator.serviceWorker.register('/service-worker.js');

  if (Notification.permission === 'granted') {
    notifyBtn.hidden = true;
    await ensureSubscribed(reg, token, vapidPublicKey);
    return;
  }

  if (!isStandalone) {
    notifyBtn.hidden = true; // iOS requires the installed home-screen app, not the Safari tab
    $('#gate-hint')?.removeAttribute('hidden');
    return;
  }

  notifyBtn.hidden = false;
  notifyBtn.addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      notifyBtn.hidden = true;
      await ensureSubscribed(reg, token, vapidPublicKey);
    }
  });
}

async function ensureSubscribed(reg, token, vapidPublicKey) {
  if (!vapidPublicKey) return;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscription: sub }),
  });
}
