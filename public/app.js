const $ = (sel) => document.querySelector(sel);
const listViewEl = $('#list-view');
const agentListEl = $('#agent-list');
const chatViewEl = $('#chat-view');
const messagesEl = $('#messages');
const chatAgentEmojiEl = $('#chat-agent-emoji');
const chatAgentNameEl = $('#chat-agent-name');
const backBtn = $('#back-btn');
const agentOptionsBtn = $('#agent-options-btn');
const modelSelect = $('#model-select');
const effortSlider = $('#effort-slider');
const effortLabel = $('#effort-label');
const usageSessionBar = $('#usage-session-bar');
const usageSessionFill = $('#usage-session-fill');
const usageWeekBar = $('#usage-week-bar');
const usageWeekFill = $('#usage-week-fill');
const usageContextBar = $('#usage-context-bar');
const usageContextFill = $('#usage-context-fill');
const clearBtn = $('#clear-btn');
const compactBtn = $('#compact-btn');
const todoBtn = $('#todo-btn');
const todoBadge = $('#todo-badge');
const todoModal = $('#todo-modal');
const todoListEl = $('#todo-list');
const todoAddForm = $('#todo-add-form');
const todoAddInput = $('#todo-add-input');
const todoCloseBtn = $('#todo-close-btn');
const newAgentBtn = $('#new-agent-btn');
const newAgentModal = $('#new-agent-modal');
const newAgentForm = $('#new-agent-form');
const agentFormTitleEl = $('#agent-form-title');
const agentFormIdInput = $('#agent-form-id');
const newAgentNameInput = $('#new-agent-name');
const newAgentWorkdirInput = $('#new-agent-workdir');
const newAgentPersonaInput = $('#new-agent-persona');
const newAgentPersonaCounterEl = $('#new-agent-persona-counter');
const newAgentErrorEl = $('#new-agent-error');
const newAgentSubmitBtn = $('#new-agent-submit');
const newAgentCancelBtn = $('#new-agent-cancel');
const agentDeleteBtn = $('#agent-delete-btn');
const emojiPickerEl = $('#emoji-picker');
const newAgentModelSelect = $('#new-agent-model');
const openrouterModal = $('#openrouter-modal');
const openrouterForm = $('#openrouter-form');
const openrouterModelInput = $('#openrouter-model-input');
const openrouterError = $('#openrouter-error');
const openrouterCancelBtn = $('#openrouter-cancel');
const formEl = $('#composer');
const inputEl = $('#input');
const sendBtn = $('#send-btn');
const slashSuggestionsEl = $('#slash-suggestions');
const statusEl = $('#status');
const notifyBtn = $('#notify-btn');
const gateEl = $('#gate');
const appEl = $('#app');
const gateBoxEl = $('#gate-box');
const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsVersionEl = $('#settings-version');
const settingsUpdateBtn = $('#settings-update-btn');
const settingsDeployBtn = $('#settings-deploy-btn');
const settingsRestartBtn = $('#settings-restart-btn');
const settingsCloseBtn = $('#settings-close-btn');
const newAgentBlurbInput = $('#new-agent-blurb');
const newRoomBtn = $('#new-room-btn');
const newRoomModal = $('#new-room-modal');
const newRoomForm = $('#new-room-form');
const roomFormTitleEl = $('#room-form-title');
const roomFormIdInput = $('#room-form-id');
const newRoomNameInput = $('#new-room-name');
const newRoomCharterInput = $('#new-room-charter');
const newRoomErrorEl = $('#new-room-error');
const newRoomSubmitBtn = $('#new-room-submit');
const newRoomCancelBtn = $('#new-room-cancel');
const roomDeleteBtn = $('#room-delete-btn');
const roomEmojiPickerEl = $('#room-emoji-picker');
const roomMemberPickerEl = $('#room-member-picker');
const roomBarEl = $('#room-bar');
const roomMembersEl = $('#room-members');
const roomStopBtn = $('#room-stop-btn');
const roomOptionsBtn = $('#room-options-btn');
const usageBarsEl = $('#usage-bars');
const jumpToLatestBtn = $('#jump-to-latest');

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
      for (const room of data.rooms || []) rooms.set(room.id, room);
      renderAgentList();
      setBadgeLocal(totalUnreadFromRoster());
      renderUsage(data.usage);

      // Cold-start deep link from a notification tap that had to launch the
      // app fresh (no running tab for the service worker to postMessage
      // into) — see service-worker.js's openWindow fallback.
      const params = new URLSearchParams(location.search);
      const deepLinkAgentId = params.get('agent');
      const deepLinkRoomId = params.get('room');
      if (deepLinkAgentId || deepLinkRoomId) {
        history.replaceState(null, '', location.pathname + location.hash);
        if (deepLinkRoomId && rooms.has(deepLinkRoomId)) openRoom(deepLinkRoomId);
        else if (deepLinkAgentId && roster.has(deepLinkAgentId)) openAgent(deepLinkAgentId);
      }
    }
  } catch (err) {
    setStatus('offline — retrying…', false);
  }

  connectSocket(token);
  setupNotifications(token, vapidPublicKey);
  setupVisibility(token);
  setupSettings(token);
  setupNewAgent(token);
  setupRooms(token);
  setupModelPicker(token);
  setupEffortPicker(token);
  setupTodos(token);
  setupNav();
}

// ---- Agent list (the landing screen) ----
const roster = new Map(); // agentId -> roster entry from the server
const rooms = new Map(); // roomId -> room entry from the server
let currentAgentId = null; // which agent's chat is open; null = list view
let currentRoomId = null; // ...or which room's — the two are mutually exclusive

function totalUnreadFromRoster() {
  let sum = 0;
  for (const entry of roster.values()) sum += entry.unreadCount || 0;
  for (const room of rooms.values()) sum += room.unreadCount || 0;
  return sum;
}

// Rooms and agents share one list, interleaved by recency — a group chat is
// just another conversation, and splitting them into sections would mean
// scrolling past a stale section to reach whatever actually moved last.
function renderAgentList() {
  agentListEl.innerHTML = '';
  const entries = [...roster.values(), ...rooms.values()]
    .sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No agents yet — tap + to create one.';
    agentListEl.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    agentListEl.appendChild(entry.kind === 'room' ? buildRoomRow(entry) : buildAgentRow(entry));
  }
}

function buildRoomRow(entry) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'agent-row room-row';
  row.dataset.roomId = entry.id;

  const avatar = document.createElement('span');
  avatar.className = 'agent-avatar';
  avatar.style.setProperty('--avatar-color', entry.color || '#7c9cff');
  avatar.textContent = entry.emoji || '👥';
  if (entry.busyMemberIds?.length) {
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
  const busy = entry.busyMemberIds?.length || 0;
  const waiting = entry.waitingMemberIds?.length || 0;
  if (busy) {
    const names = entry.members
      .filter((m) => entry.busyMemberIds.includes(m.id))
      .map((m) => m.name)
      .join(', ');
    preview.textContent = `${names} ${busy === 1 ? 'is' : 'are'} replying…`;
  } else if (waiting) {
    // Nothing will visibly happen here until the limit resets, which is worth
    // saying rather than leaving the room looking like it just went quiet.
    const soonest = Math.min(...entry.waitingMemberIds.map((w) => w.resumesAt));
    preview.textContent = `Rate limited — resumes ${formatResumeTime(soonest)}`;
  } else if (entry.lastMessage) {
    preview.textContent = `${entry.lastMessage.sender}: ${extractOptions(entry.lastMessage.text).cleanText.slice(0, 70)}`;
  } else {
    preview.textContent = entry.members.length
      ? `${entry.members.length} member${entry.members.length === 1 ? '' : 's'} · no messages yet`
      : 'No members yet';
  }
  body.append(nameLine, preview);

  const meta = document.createElement('span');
  meta.className = 'agent-row-meta';
  const time = document.createElement('span');
  time.className = 'agent-row-time';
  time.textContent = formatPreviewTime(entry.lastMessage?.ts);
  meta.appendChild(time);

  const badges = document.createElement('span');
  badges.className = 'agent-row-badges';
  const stack = document.createElement('span');
  stack.className = 'room-member-stack';
  for (const m of entry.members.slice(0, 4)) {
    const chip = document.createElement('span');
    chip.className = 'room-member-chip';
    chip.textContent = m.emoji || '🤖';
    chip.title = m.name;
    stack.appendChild(chip);
  }
  badges.appendChild(stack);
  if (entry.unreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'agent-row-badge';
    badge.textContent = entry.unreadCount > 99 ? '99+' : String(entry.unreadCount);
    badges.appendChild(badge);
  }
  meta.appendChild(badges);

  row.append(avatar, body, meta);
  row.addEventListener('click', () => openRoom(entry.id));
  return row;
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
  row.className = 'agent-row' + (entry.sleeping && !entry.working ? ' sleeping' : '');
  row.dataset.agentId = entry.id;

  const avatar = document.createElement('span');
  avatar.className = 'agent-avatar';
  avatar.style.setProperty('--avatar-color', entry.color || '#7c9cff');
  avatar.textContent = entry.emoji || '🤖';
  if (entry.working) {
    const dot = document.createElement('span');
    dot.className = 'agent-working-dot' + (entry.working.waitingUntil ? ' waiting' : '');
    avatar.appendChild(dot);
  }

  const body = document.createElement('span');
  body.className = 'agent-row-body';
  const asleep = entry.sleeping && !entry.working;
  const nameLine = document.createElement('span');
  nameLine.className = 'agent-row-name';
  nameLine.textContent = (asleep ? '💤 ' : '') + entry.name;
  if (asleep) nameLine.title = 'Asleep — will wake on your next message';
  const preview = document.createElement('span');
  preview.className = 'agent-row-preview';
  preview.textContent = entry.working
    ? (entry.working.waitingUntil ? `Rate limited — resumes ${formatResumeTime(entry.working.waitingUntil)}` : 'Working…')
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
  if (entry.openTodoCount > 0 || entry.unreadCount > 0) {
    const badges = document.createElement('span');
    badges.className = 'agent-row-badges';
    if (entry.openTodoCount > 0) {
      const todoBadge = document.createElement('span');
      todoBadge.className = 'agent-row-todo-badge';
      todoBadge.title = `${entry.openTodoCount} open task${entry.openTodoCount === 1 ? '' : 's'}`;
      todoBadge.textContent = `✅ ${entry.openTodoCount > 99 ? '99+' : entry.openTodoCount}`;
      badges.appendChild(todoBadge);
    }
    if (entry.unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'agent-row-badge';
      badge.textContent = entry.unreadCount > 99 ? '99+' : String(entry.unreadCount);
      badges.appendChild(badge);
    }
    meta.appendChild(badges);
  }

  row.append(avatar, body, meta);
  row.addEventListener('click', () => openAgent(entry.id));
  return row;
}

// ---- Composer drafts: one unfinished message per agent, saved to
// localStorage (not just a JS variable) so a half-written thought survives
// switching to another agent, backgrounding the app, or iOS fully killing
// the PWA — not just navigating away within the app.
const DRAFTS_KEY = 'xqlytskg_drafts';

function loadDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
  } catch {
    return {};
  }
}

function getDraft(agentId) {
  return agentId ? loadDrafts()[agentId] || '' : '';
}

function saveDraft(agentId, text) {
  if (!agentId) return;
  const drafts = loadDrafts();
  if (text) drafts[agentId] = text;
  else delete drafts[agentId];
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  // Published for #jump-to-latest, which floats just above the composer and
  // would otherwise be hidden behind it once the textarea grows.
  chatViewEl.style.setProperty('--composer-h', formEl.offsetHeight + 'px');
}

function showListView() {
  if (currentAgentId) saveDraft(currentAgentId, inputEl.value);
  if (currentRoomId) saveDraft('room:' + currentRoomId, inputEl.value);
  currentAgentId = null;
  currentRoomId = null;
  inputEl.value = '';
  chatViewEl.hidden = true;
  listViewEl.hidden = false;
  pinnedToBottom = true; // next chat opens at its bottom, whatever this one was doing
  updateJumpToLatest();
  resetWorkIndicatorState(); // stop the per-second timer for the chat we're leaving
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'view', agentId: null }));
    ws.send(JSON.stringify({ type: 'room_view', roomId: null }));
  }
  renderAgentList();
}

// Rooms and agent DMs share the one chat screen — the difference is which
// controls apply. Model/effort/context/todos are all properties of a single
// agent's session and mean nothing for a room, so they're swapped out for the
// member list and the room-wide stop.
function setChatMode(mode) {
  const isRoom = mode === 'room';
  roomBarEl.hidden = !isRoom;
  usageBarsEl.hidden = isRoom;
  modelSelect.hidden = isRoom;
  agentOptionsBtn.hidden = isRoom;
  roomOptionsBtn.hidden = !isRoom;
  // Nothing happens in a room until someone is addressed, so the composer
  // should say so rather than leaving you to discover it.
  inputEl.placeholder = isRoom ? '@mention someone…' : 'Message…';
}

function renderRoomMembers(entry) {
  roomMembersEl.innerHTML = '';
  for (const m of entry.members) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'room-bar-chip';
    const busy = entry.busyMemberIds?.includes(m.id);
    const pending = entry.pendingMemberIds?.includes(m.id);
    const waiting = entry.waitingMemberIds?.find((w) => w.id === m.id);
    if (busy) chip.classList.add('busy');
    if (waiting) chip.classList.add('waiting');
    chip.style.setProperty('--chip-color', m.color || '#7c9cff');
    chip.textContent = `${waiting ? '⏳ ' : ''}${m.emoji || '🤖'} ${m.name}`;
    chip.title = waiting
      ? `${m.name} hit its usage limit — resumes ${formatResumeTime(waiting.resumesAt)}`
      : busy
        ? `${m.name} is replying…`
        : pending
          ? `${m.name} hasn't read the latest yet — it will catch up on its next turn`
          : m.blurb || m.name;
    if (pending && !busy && !waiting) {
      const dot = document.createElement('span');
      dot.className = 'room-chip-pending';
      chip.appendChild(dot);
    }
    // Tapping a member jumps to its own DM — the place to ask it something
    // the rest of the room doesn't need to read.
    chip.addEventListener('click', () => openAgent(m.id));
    roomMembersEl.appendChild(chip);
  }
}

async function openRoom(roomId) {
  if (currentAgentId) saveDraft(currentAgentId, inputEl.value);
  if (currentRoomId && currentRoomId !== roomId) saveDraft('room:' + currentRoomId, inputEl.value);
  const entry = rooms.get(roomId);
  currentRoomId = roomId;
  currentAgentId = null;
  chatAgentEmojiEl.textContent = entry?.emoji || '👥';
  chatAgentNameEl.textContent = entry?.name || '';
  setChatMode('room');
  if (entry) renderRoomMembers(entry);
  listViewEl.hidden = true;
  chatViewEl.hidden = false;
  messagesEl.innerHTML = '';
  pinnedToBottom = true; // a freshly opened chat always starts at its newest message
  updateJumpToLatest();
  resetWorkIndicatorState();
  messagePagination = { hasMore: false, loading: false, oldestLoadedId: null };
  inputEl.value = getDraft('room:' + roomId);
  autoResizeInput();
  updateSendButtonMode();
  hideSlashSuggestions();
  todoModal.hidden = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'room_view', roomId }));
  }

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    const data = await res.json();
    for (const m of data.messages || []) renderRoomMessage(m);
    scrollToBottom();
  } catch {
    /* WS will surface connectivity issues via the list-view status line */
  }

  if (entry) {
    entry.unreadCount = 0;
    setBadgeLocal(totalUnreadFromRoster());
  }
}

// Room messages carry a sender, so they need a name label the DM view never
// does — with three or more voices in the feed, colour alone isn't enough to
// tell who said what.
function renderRoomMessage(m) {
  if (m.role === 'system') {
    const note = document.createElement('div');
    note.className = 'msg room-system';
    note.id = 'm-' + m.id;
    note.textContent = m.text;
    messagesEl.appendChild(note);
    return;
  }

  const isHuman = !m.agentId;
  const member = m.agentId ? rooms.get(currentRoomId)?.members.find((x) => x.id === m.agentId) : null;

  const el = document.createElement('div');
  el.className = `msg ${isHuman ? 'user' : 'assistant'} room-msg`;
  el.id = 'm-' + m.id;

  if (!isHuman) {
    const sender = document.createElement('div');
    sender.className = 'room-msg-sender';
    sender.style.setProperty('--sender-color', member?.color || '#7c9cff');
    sender.textContent = `${member?.emoji || '🤖'} ${m.sender || member?.name || 'Agent'}`;
    el.appendChild(sender);
  }

  const { cleanText, options } = extractOptions(m.text);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(cleanText);
  styleMentions(bubble);
  addCodeCopyButtons(bubble);
  el.appendChild(bubble);
  if (options.length) el.appendChild(buildOptionButtons(options));
  el.appendChild(buildCopyButton(cleanText));

  messagesEl.appendChild(el);
}

// Kept identical to the server's parser (server/index.js) — a mention shown
// as highlighted here but not actually delivered there would be the worst
// possible lie this UI could tell.
const MENTION_AT_PREFIX = '@(?:[\\p{Extended_Pictographic}\\p{Emoji_Component}\\uFE0F\\u200D]+\\s*)?';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// @mentions are the routing mechanism, so they need to read as such —
// scanning a transcript for who was actually handed the next turn is the main
// thing you do when catching up on a discussion you didn't watch live. Done
// by walking text nodes of the already-rendered markdown rather than by
// injecting markup into the source text: the message text comes from agents,
// so it never gets to contribute HTML.
function styleMentions(container) {
  const members = rooms.get(currentRoomId)?.members || [];
  if (!members.length) return;

  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  const alternatives = sorted
    .flatMap((m) => [escapeRegex(m.name), escapeRegex(m.name.replace(/\s+/g, ''))])
    .join('|');
  const re = new RegExp(`${MENTION_AT_PREFIX}(${alternatives})(?![\\w-])`, 'giu');

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    // Code blocks are quoting, not addressing — a mention inside one should
    // not look like it routed anywhere.
    if (node.parentElement?.closest('code, pre')) continue;
    re.lastIndex = 0;
    if (re.test(node.nodeValue)) targets.push(node);
  }

  for (const textNode of targets) {
    const text = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text))) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const matchedName = match[1].toLowerCase();
      const member = sorted.find(
        (m) => m.name.toLowerCase() === matchedName || m.name.replace(/\s+/g, '').toLowerCase() === matchedName
      );
      const span = document.createElement('span');
      span.className = 'mention';
      span.style.setProperty('--mention-color', member?.color || '#7c9cff');
      span.textContent = match[0];
      frag.appendChild(span);
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

// ---- Message pagination state ----
let messagePagination = {
  hasMore: false,
  loading: false,
  oldestLoadedId: null,
};

async function openAgent(agentId) {
  if (currentAgentId && currentAgentId !== agentId) saveDraft(currentAgentId, inputEl.value);
  if (currentRoomId) saveDraft('room:' + currentRoomId, inputEl.value);
  const entry = roster.get(agentId);
  currentAgentId = agentId;
  currentRoomId = null;
  chatAgentEmojiEl.textContent = entry?.emoji || '🤖';
  chatAgentNameEl.textContent = entry?.name || '';
  setChatMode('agent');
  syncModelSelect(entry);
  syncEffortSlider(entry);
  listViewEl.hidden = true;
  chatViewEl.hidden = false;
  messagesEl.innerHTML = '';
  pinnedToBottom = true; // a freshly opened chat always starts at its newest message
  updateJumpToLatest();
  resetWorkIndicatorState();
  messagePagination = { hasMore: false, loading: false, oldestLoadedId: null };
  inputEl.value = getDraft(agentId);
  autoResizeInput();
  updateSendButtonMode();
  hideSlashSuggestions();
  todoModal.hidden = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'view', agentId }));
    ws.send(JSON.stringify({ type: 'room_view', roomId: null }));
  }

  fetchTodos(agentId).then((todos) => {
    if (currentAgentId === agentId) {
      currentTodos = todos;
      renderTodoBadge(todos);
    }
  });

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/messages?limit=5`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    const data = await res.json();
    for (const m of data.messages || []) renderMessage(m);
    messagePagination.hasMore = data.hasMore;
    messagePagination.oldestLoadedId = data.messages?.[0]?.id || null;
    scrollToBottom();
    // This agent's own context reading — never whatever was left on screen
    // from the previously open agent, and never a stale one carried over
    // from before a model switch (the server discards it on bridge restart,
    // so null here correctly means "no reading yet, next check will fill it in").
    renderContextUsage(data.context);
    compactingSince = data.compacting?.startedAt ?? null;
    if (data.working) {
      // Opening (or reopening, after a reconnect) a chat mid-turn: replay
      // everything that already happened — tool calls made so far, thinking
      // accumulated so far, reply text streamed so far — instead of just a
      // bare "Thinking…" with no history, which is all a fresh work-status
      // broadcast could show on its own.
      startWorkIndicator(data.working.startedAt, data.working.tool, data.working.waitingUntil);
      for (const t of data.working.tools || []) {
        createLiveTool(t.id, t.name, t.input);
        if (t.result !== null) updateLiveTool(t.id, t.isError, t.result);
      }
      liveThinkingText = data.working.thinkingText || '';
      liveThinkingTokens = data.working.thinkingTokens || 0;
      renderLiveThinking();
      if (data.working.deltaText) appendLiveDelta(data.working.deltaText);
    } else if (compactingSince) {
      startWorkIndicator(compactingSince, null);
    }
  } catch {
    /* WS will surface connectivity issues via the list-view status line */
  }

  if (entry) {
    entry.unreadCount = 0;
    setBadgeLocal(totalUnreadFromRoster());
  }
}

// Load older messages when scrolling up
async function loadMoreMessages() {
  if (!currentAgentId || messagePagination.loading || !messagePagination.hasMore || !messagePagination.oldestLoadedId) return;
  messagePagination.loading = true;

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/messages?limit=10&before=${encodeURIComponent(messagePagination.oldestLoadedId)}`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    const data = await res.json();
    const olderMessages = data.messages || [];

    // Prepend older messages while preserving scroll position
    const firstChild = messagesEl.firstChild;
    const scrollHeightBefore = messagesEl.scrollHeight;
    const fragment = document.createDocumentFragment();
    for (const m of olderMessages) {
      if (m.role === 'room-ref') {
        fragment.appendChild(buildRoomRefEl(m));
        continue;
      }
      if (m.role === 'compact-summary' || m.role === 'clear-summary') {
        fragment.appendChild(buildCompactSummaryEl(m));
        continue;
      }
      const el = document.createElement('div');
      el.id = 'm-' + m.id;
      el.className = `msg ${m.role}`;
      const { cleanText, options } = extractOptions(m.text);
      const bubble = document.createElement('div');
      bubble.className = 'bubble' + (m.isError ? ' error' : '');
      bubble.innerHTML = renderMarkdown(cleanText);
      addCodeCopyButtons(bubble);
      el.appendChild(bubble);
      if (options.length) el.appendChild(buildOptionButtons(options));
      el.appendChild(buildCopyButton(cleanText));
      const thinkingDetails = buildThinkingDetails(m.thinking, m.thinkingTokens);
      if (thinkingDetails) el.appendChild(thinkingDetails);
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
      fragment.appendChild(el);
    }
    messagesEl.insertBefore(fragment, firstChild);
    // Adjust scrollTop to keep the same visual position after prepending
    messagesEl.scrollTop += messagesEl.scrollHeight - scrollHeightBefore;

    messagePagination.hasMore = data.hasMore;
    messagePagination.oldestLoadedId = olderMessages[0]?.id || null;
  } catch (err) {
    console.error('Failed to load more messages:', err);
  } finally {
    messagePagination.loading = false;
  }
}

// Scroll listener for loading more messages
messagesEl.addEventListener('scroll', () => {
  // The only place the pin is (re)decided — see scrollToBottomIfPinned.
  pinnedToBottom = distanceFromBottom() <= SCROLL_PIN_THRESHOLD;
  updateJumpToLatest();
  // Load more when scrolled near top (within 200px)
  if (messagesEl.scrollTop < 200) {
    loadMoreMessages();
  }
});

function setupNav() {
  backBtn.addEventListener('click', showListView);
  jumpToLatestBtn.addEventListener('click', () => scrollToBottom());
}

// A shortcut for typing "/compact" by hand — same message, just one tap.
compactBtn.addEventListener('click', () => {
  sendMessage('/compact');
});

// /clear wipes the conversation's context outright (unlike /compact, which
// summarizes) — confirm first, same as the other destructive actions here.
clearBtn.addEventListener('click', () => {
  if (confirm('Clear this conversation? This resets its context.')) {
    sendMessage('/clear');
  }
});

// ---- Agent creation / editing (one sheet, two modes) ----
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

// Server truncates systemPrompt to this many characters (server/index.js);
// token count is a rough chars/4 estimate, not a real tokenizer count.
const PERSONA_MAX_CHARS = 16000;

function updatePersonaCounter() {
  const len = newAgentPersonaInput.value.length;
  const tokens = Math.round(len / 4);
  newAgentPersonaCounterEl.textContent = `${len} / ${PERSONA_MAX_CHARS} chars · ~${tokens} tokens`;
  newAgentPersonaCounterEl.classList.toggle('over-limit', len > PERSONA_MAX_CHARS);
}

function setColorSelection(color) {
  selectedColor = color;
  for (const b of document.querySelectorAll('#new-agent-colors .theme-swatch')) {
    b.classList.toggle('active', b.dataset.color === color);
  }
}

// agentId === null opens the sheet in "create" mode; otherwise it's
// pre-filled from the roster entry and switches to "edit" mode (PATCH +
// a Delete button) instead of creating a new agent.
function openAgentForm(agentId) {
  const entry = agentId ? roster.get(agentId) : null;
  agentFormIdInput.value = agentId || '';
  agentFormTitleEl.textContent = entry ? 'Edit agent' : 'New agent';
  newAgentSubmitBtn.textContent = entry ? 'Save changes' : 'Create agent';
  agentDeleteBtn.hidden = !entry;
  newAgentErrorEl.hidden = true;

  newAgentNameInput.value = entry?.name || '';
  newAgentWorkdirInput.value = entry?.workdir || '';
  newAgentBlurbInput.value = entry?.blurb || '';
  newAgentPersonaInput.value = entry?.systemPrompt || '';
  updatePersonaCounter();
  selectedEmoji = entry?.emoji || AGENT_EMOJIS[0];
  buildEmojiPicker();
  setColorSelection(entry?.color || '#7c9cff');
  // This form's dropdown only knows the 4 built-in models — an agent
  // switched to a custom OpenRouter id (set via the header quick-switch)
  // has no matching <option> here, so we leave the select at its default
  // and track whether the user actually touches it, rather than trying to
  // preselect a value that doesn't exist and silently corrupting it on save.
  editFormModelTouched = false;
  newAgentModelSelect.value = (entry && entry.provider !== 'openrouter') ? entry.model : 'sonnet';

  newAgentModal.hidden = false;
}

let editFormModelTouched = false;

// ---- Group chat creation / editing (same one-sheet-two-modes pattern) ----
const ROOM_EMOJIS = ['👥', '🧩', '🔧', '🚨', '🧱', '🗂️', '🧭', '⚙️', '🔭', '🏗️', '🧯', '📐'];
let selectedRoomEmoji = ROOM_EMOJIS[0];
let selectedMemberIds = new Set();

function buildRoomEmojiPicker() {
  roomEmojiPickerEl.innerHTML = '';
  for (const emoji of ROOM_EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-option' + (emoji === selectedRoomEmoji ? ' active' : '');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      selectedRoomEmoji = emoji;
      for (const b of roomEmojiPickerEl.querySelectorAll('.emoji-option')) b.classList.toggle('active', b === btn);
    });
    roomEmojiPickerEl.appendChild(btn);
  }
}

function buildMemberPicker() {
  roomMemberPickerEl.innerHTML = '';
  const agents = [...roster.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!agents.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No agents to invite yet.';
    roomMemberPickerEl.appendChild(hint);
    return;
  }
  for (const agent of agents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-option' + (selectedMemberIds.has(agent.id) ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'member-option-name';
    label.textContent = `${agent.emoji || '🤖'} ${agent.name}`;
    btn.appendChild(label);
    if (agent.blurb) {
      const desc = document.createElement('span');
      desc.className = 'member-option-desc';
      desc.textContent = agent.blurb;
      btn.appendChild(desc);
    }
    btn.addEventListener('click', () => {
      if (selectedMemberIds.has(agent.id)) selectedMemberIds.delete(agent.id);
      else selectedMemberIds.add(agent.id);
      btn.classList.toggle('active', selectedMemberIds.has(agent.id));
    });
    roomMemberPickerEl.appendChild(btn);
  }
}

function openRoomForm(roomId) {
  const entry = roomId ? rooms.get(roomId) : null;
  roomFormIdInput.value = roomId || '';
  roomFormTitleEl.textContent = entry ? 'Edit group chat' : 'New group chat';
  newRoomSubmitBtn.textContent = entry ? 'Save changes' : 'Create group chat';
  roomDeleteBtn.hidden = !entry;
  newRoomErrorEl.hidden = true;

  newRoomNameInput.value = entry?.name || '';
  newRoomCharterInput.value = entry?.charter || '';
  selectedRoomEmoji = entry?.emoji || ROOM_EMOJIS[0];
  selectedMemberIds = new Set(entry?.memberIds || []);
  buildRoomEmojiPicker();
  buildMemberPicker();

  newRoomModal.hidden = false;
}

function setupRooms(token) {
  newRoomBtn.addEventListener('click', () => openRoomForm(null));
  roomOptionsBtn.addEventListener('click', () => {
    if (currentRoomId) openRoomForm(currentRoomId);
  });
  newRoomCancelBtn.addEventListener('click', () => {
    newRoomModal.hidden = true;
  });
  newRoomModal.addEventListener('click', (e) => {
    if (e.target === newRoomModal) newRoomModal.hidden = true;
  });

  roomStopBtn.addEventListener('click', () => {
    if (currentRoomId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room_stop', roomId: currentRoomId }));
    }
  });

  newRoomForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    newRoomErrorEl.hidden = true;
    const editingId = roomFormIdInput.value || null;
    newRoomSubmitBtn.disabled = true;
    newRoomSubmitBtn.textContent = editingId ? 'Saving…' : 'Creating…';
    try {
      const res = await fetch(editingId ? `/api/rooms/${encodeURIComponent(editingId)}` : '/api/rooms', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newRoomNameInput.value,
          emoji: selectedRoomEmoji,
          charter: newRoomCharterInput.value,
          memberIds: [...selectedMemberIds],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      rooms.set(data.room.id, data.room);
      newRoomModal.hidden = true;
      if (currentRoomId === data.room.id) {
        chatAgentEmojiEl.textContent = data.room.emoji || '👥';
        chatAgentNameEl.textContent = data.room.name;
        renderRoomMembers(data.room);
      }
      renderAgentList();
    } catch (err) {
      newRoomErrorEl.textContent = err.message;
      newRoomErrorEl.hidden = false;
    } finally {
      newRoomSubmitBtn.disabled = false;
      newRoomSubmitBtn.textContent = roomFormIdInput.value ? 'Save changes' : 'Create group chat';
    }
  });

  roomDeleteBtn.addEventListener('click', async () => {
    const roomId = roomFormIdInput.value;
    if (!roomId) return;
    const entry = rooms.get(roomId);
    // Deleting a room throws away its transcript; the members and their own
    // histories are untouched, which is worth saying explicitly here.
    if (!confirm(`Delete "${entry?.name || 'this group chat'}"? The discussion is lost — the agents themselves are not.`)) return;
    roomDeleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('failed');
      rooms.delete(roomId);
      newRoomModal.hidden = true;
      if (currentRoomId === roomId) showListView();
      else renderAgentList();
    } catch {
      newRoomErrorEl.textContent = 'Could not delete this group chat.';
      newRoomErrorEl.hidden = false;
    } finally {
      roomDeleteBtn.disabled = false;
    }
  });
}

function setupNewAgent(token) {
  newAgentModelSelect.addEventListener('change', () => {
    editFormModelTouched = true;
  });
  newAgentPersonaInput.addEventListener('input', updatePersonaCounter);
  newAgentBtn.addEventListener('click', () => openAgentForm(null));
  agentOptionsBtn.addEventListener('click', () => {
    if (currentAgentId) openAgentForm(currentAgentId);
  });

  newAgentCancelBtn.addEventListener('click', () => {
    newAgentModal.hidden = true;
  });

  newAgentModal.addEventListener('click', (e) => {
    if (e.target === newAgentModal) newAgentModal.hidden = true;
  });

  for (const btn of document.querySelectorAll('#new-agent-colors .theme-swatch')) {
    btn.addEventListener('click', () => setColorSelection(btn.dataset.color));
  }

  newAgentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    newAgentErrorEl.hidden = true;
    const editingId = agentFormIdInput.value || null;
    newAgentSubmitBtn.disabled = true;
    newAgentSubmitBtn.textContent = editingId ? 'Saving…' : 'Creating…';
    const payload = {
      name: newAgentNameInput.value,
      emoji: selectedEmoji,
      color: selectedColor,
      workdir: newAgentWorkdirInput.value,
      blurb: newAgentBlurbInput.value,
      systemPrompt: newAgentPersonaInput.value,
    };
    // Only touch model/provider on an edit if the user actually changed the
    // dropdown — this form doesn't know about custom OpenRouter ids set via
    // the header quick-switch, so leaving it alone preserves those untouched.
    if (!editingId || editFormModelTouched) {
      payload.model = newAgentModelSelect.value;
      payload.provider = 'anthropic';
    }
    try {
      const res = await fetch(editingId ? `/api/agents/${encodeURIComponent(editingId)}` : '/api/agents', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        newAgentErrorEl.textContent = data.error || 'Could not save agent.';
        newAgentErrorEl.hidden = false;
        return;
      }
      roster.set(data.agent.id, data.agent);
      newAgentModal.hidden = true;
      renderAgentList();
      if (editingId && currentAgentId === editingId) {
        chatAgentEmojiEl.textContent = data.agent.emoji;
        chatAgentNameEl.textContent = data.agent.name;
      } else if (!editingId) {
        openAgent(data.agent.id);
      }
    } catch {
      newAgentErrorEl.textContent = 'Network error — try again.';
      newAgentErrorEl.hidden = false;
    } finally {
      newAgentSubmitBtn.disabled = false;
      newAgentSubmitBtn.textContent = editingId ? 'Save changes' : 'Create agent';
    }
  });

  agentDeleteBtn.addEventListener('click', async () => {
    const agentId = agentFormIdInput.value;
    if (!agentId) return;
    const entry = roster.get(agentId);
    if (!confirm(`Delete ${entry?.name || 'this agent'}? This removes its chat history from this app permanently.`)) {
      return;
    }
    agentDeleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        newAgentErrorEl.textContent = data.error || 'Could not delete agent.';
        newAgentErrorEl.hidden = false;
        return;
      }
      roster.delete(agentId);
      newAgentModal.hidden = true;
      if (currentAgentId === agentId) showListView();
      else renderAgentList();
      saveDraft(agentId, ''); // purge — showListView() above may have just re-saved a stale one
    } catch {
      newAgentErrorEl.textContent = 'Network error — try again.';
      newAgentErrorEl.hidden = false;
    } finally {
      agentDeleteBtn.disabled = false;
    }
  });
}

// An OpenRouter model id (e.g. "deepseek/deepseek-chat-v3-0324:free") won't
// match any of the select's static <option> values, so a plain `.value =`
// assignment silently falls back to the first option instead of showing
// what's actually active. This keeps one dynamic <option> in sync with
// whatever custom id the agent is currently on, so selection always sticks.
function syncModelSelect(entry) {
  const provider = entry?.provider || 'anthropic';
  const model = entry?.model || 'sonnet';
  let customOpt = modelSelect.querySelector('option[data-custom]');
  if (provider === 'openrouter') {
    if (!customOpt) {
      customOpt = document.createElement('option');
      customOpt.dataset.custom = '1';
      modelSelect.appendChild(customOpt);
    }
    customOpt.value = model;
    customOpt.textContent = `OpenRouter: ${model}`;
    modelSelect.value = model;
  } else {
    if (customOpt) customOpt.remove();
    modelSelect.value = model;
  }
}

// ---- Reasoning effort slider (chat header) — 5 discrete stops matching the
// CLI's own `--effort` flag values. Same lazy-apply model as the picker
// below: persisted via PATCH, actually applied to the running bridge right
// before the next message, so it never interrupts a turn in flight.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };

function syncEffortSlider(entry) {
  const effort = entry?.effort || 'medium';
  const idx = EFFORT_LEVELS.indexOf(effort);
  effortSlider.value = String(idx === -1 ? 1 : idx);
  effortLabel.textContent = EFFORT_LABELS[effort] || 'Medium';
}

function setupEffortPicker(token) {
  // Live label update while dragging; the native step="1" already snaps the
  // thumb itself, this just keeps the text in sync as it moves.
  effortSlider.addEventListener('input', () => {
    const level = EFFORT_LEVELS[Number(effortSlider.value)];
    effortLabel.textContent = EFFORT_LABELS[level];
  });

  // Fires once on release/commit (not per-drag-frame) — that's when we
  // actually persist the choice.
  effortSlider.addEventListener('change', () => {
    const agentId = currentAgentId;
    if (!agentId) return;
    const previousEntry = roster.get(agentId);
    const level = EFFORT_LEVELS[Number(effortSlider.value)];

    (async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ effort: level }),
        });
        const data = await res.json();
        if (!res.ok) {
          syncEffortSlider(previousEntry);
          setStatus(data.error || 'Could not switch effort', false);
          return;
        }
        roster.set(data.agent.id, data.agent);
        syncEffortSlider(data.agent);
      } catch {
        syncEffortSlider(previousEntry);
        setStatus('offline — try again', false);
      }
    })();
  });
}

// ---- Quick model switch (chat header) — separate from the full edit form
// since this is meant for fast, frequent switching mid-conversation based
// on how demanding the next task is, not a one-time setup choice.
// Picking a model here doesn't touch the running process — the server
// just records the choice and applies it (restarting that agent's bridge,
// same session) right before the *next* message is sent, so it never
// interrupts whatever's currently in flight.
// Picking an OpenRouter model needs a real text input, not window.prompt() —
// iOS silently no-ops synchronous dialogs (alert/confirm/prompt) inside a
// home-screen-installed PWA, so prompt() here looked like tapping the option
// did nothing at all and just reverted the select.
let openrouterPendingAgentId = null;
let openrouterPendingPreviousEntry = null;

function closeOpenrouterModal(revert) {
  openrouterModal.hidden = true;
  openrouterError.hidden = true;
  if (revert) syncModelSelect(openrouterPendingPreviousEntry);
  openrouterPendingAgentId = null;
  openrouterPendingPreviousEntry = null;
}

function setupModelPicker(token) {
  modelSelect.addEventListener('change', () => {
    const agentId = currentAgentId;
    if (!agentId) return;
    const previousEntry = roster.get(agentId);

    if (modelSelect.value === '__openrouter__') {
      openrouterPendingAgentId = agentId;
      openrouterPendingPreviousEntry = previousEntry;
      openrouterModelInput.value = previousEntry?.provider === 'openrouter' ? previousEntry.model : '';
      openrouterError.hidden = true;
      openrouterModal.hidden = false;
      openrouterModelInput.focus();
      return;
    }

    const model = modelSelect.value;
    (async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ model, provider: 'anthropic' }),
        });
        const data = await res.json();
        if (!res.ok) {
          syncModelSelect(previousEntry);
          setStatus(data.error || 'Could not switch model', false);
          return;
        }
        roster.set(data.agent.id, data.agent);
        syncModelSelect(data.agent);
      } catch {
        syncModelSelect(previousEntry);
        setStatus('offline — try again', false);
      }
    })();
  });

  openrouterCancelBtn.addEventListener('click', () => closeOpenrouterModal(true));
  openrouterModal.addEventListener('click', (e) => {
    if (e.target === openrouterModal) closeOpenrouterModal(true);
  });

  openrouterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const agentId = openrouterPendingAgentId;
    const model = openrouterModelInput.value.trim();
    if (!agentId || !model) return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, provider: 'openrouter' }),
      });
      const data = await res.json();
      if (!res.ok) {
        openrouterError.textContent = data.error || 'Could not switch model';
        openrouterError.hidden = false;
        return;
      }
      roster.set(data.agent.id, data.agent);
      syncModelSelect(data.agent);
      closeOpenrouterModal(false);
    } catch {
      openrouterError.textContent = 'offline — try again';
      openrouterError.hidden = false;
    }
  });
}

// ---- Todos: a lightweight per-agent task list, separate from chat history.
// Three effective states: open -> done (either of us can mark it) -> gone
// (removal is meant to be a deliberate step, typically after verifying the
// work — nothing here stops either side from deleting, but the workflow is
// "AI checks it off, human removes it once actually confirmed").
let currentTodos = [];

function renderTodoBadge(todos) {
  const openCount = todos.filter((t) => t.status !== 'done').length;
  todoBadge.textContent = openCount > 99 ? '99+' : String(openCount);
  todoBadge.hidden = openCount === 0;
}

function buildTodoItem(todo) {
  const el = document.createElement('div');
  el.className = 'todo-item' + (todo.status === 'done' ? ' done' : '');

  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'todo-check';
  checkBtn.setAttribute('aria-label', todo.status === 'done' ? 'Mark not done' : 'Mark done');
  checkBtn.textContent = todo.status === 'done' ? '✓' : '';
  checkBtn.addEventListener('click', () => {
    patchTodo(todo.id, { status: todo.status === 'done' ? 'open' : 'done' });
  });

  const textEl = document.createElement('span');
  textEl.className = 'todo-text';
  textEl.textContent = todo.text;
  textEl.addEventListener('click', () => startEditingTodo(textEl, todo));

  const actions = document.createElement('div');
  actions.className = 'todo-actions';
  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'todo-move';
  upBtn.textContent = '↑';
  upBtn.setAttribute('aria-label', 'Move up');
  upBtn.addEventListener('click', () => moveTodo(todo.id, 'up'));
  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'todo-move';
  downBtn.textContent = '↓';
  downBtn.setAttribute('aria-label', 'Move down');
  downBtn.addEventListener('click', () => moveTodo(todo.id, 'down'));
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'todo-delete';
  delBtn.textContent = '🗑';
  delBtn.setAttribute('aria-label', 'Delete task');
  delBtn.addEventListener('click', () => {
    if (confirm('Remove this task?')) deleteTodo(todo.id);
  });
  actions.append(upBtn, downBtn, delBtn);

  el.append(checkBtn, textEl, actions);
  return el;
}

function startEditingTodo(textEl, todo) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-edit-input';
  input.value = todo.text;
  input.maxLength = 500;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = (save) => {
    if (save && input.value.trim() && input.value.trim() !== todo.text) {
      patchTodo(todo.id, { text: input.value.trim() });
    } else if (input.isConnected) {
      input.replaceWith(textEl); // cancelled/unchanged — just revert visually
    }
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
}

function renderTodoList(todos) {
  todoListEl.innerHTML = '';
  if (!todos.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No tasks yet.';
    todoListEl.appendChild(empty);
    return;
  }
  for (const todo of todos) todoListEl.appendChild(buildTodoItem(todo));
}

async function fetchTodos(agentId) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/todos`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    const data = await res.json();
    return data.todos || [];
  } catch {
    return [];
  }
}

async function patchTodo(todoId, patch) {
  if (!currentAgentId) return;
  try {
    await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/todos/${encodeURIComponent(todoId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify(patch),
    });
  } catch {
    /* the todos_update broadcast (or lack thereof) is the source of truth */
  }
}

async function moveTodo(todoId, direction) {
  if (!currentAgentId) return;
  try {
    await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/todos/${encodeURIComponent(todoId)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({ direction }),
    });
  } catch {
    /* ignore — see patchTodo */
  }
}

async function deleteTodo(todoId) {
  if (!currentAgentId) return;
  try {
    await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/todos/${encodeURIComponent(todoId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${currentToken}` },
    });
  } catch {
    /* ignore — see patchTodo */
  }
}

async function openTodoPanel() {
  if (!currentAgentId) return;
  todoModal.hidden = false;
  currentTodos = await fetchTodos(currentAgentId);
  renderTodoList(currentTodos);
  renderTodoBadge(currentTodos);
}

function setupTodos(token) {
  todoBtn.addEventListener('click', openTodoPanel);
  todoCloseBtn.addEventListener('click', () => {
    todoModal.hidden = true;
  });
  todoModal.addEventListener('click', (e) => {
    if (e.target === todoModal) todoModal.hidden = true;
  });
  todoAddForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = todoAddInput.value.trim();
    if (!text || !currentAgentId) return;
    todoAddInput.value = '';
    try {
      await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      });
    } catch {
      /* ignore — see patchTodo */
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

  settingsDeployBtn.addEventListener('click', async () => {
    if (!confirm('Pull the latest main branch from git and restart the service?')) {
      return;
    }
    settingsDeployBtn.disabled = true;
    settingsDeployBtn.textContent = 'Pulling…';
    try {
      const res = await fetch('/api/deploy', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'update failed');
      if (!data.updated) {
        settingsDeployBtn.textContent = 'Already up to date';
        setTimeout(() => {
          settingsDeployBtn.disabled = false;
          settingsDeployBtn.textContent = 'Pull latest & restart';
        }, 2000);
        return;
      }
      settingsDeployBtn.textContent = 'Restarting…';
      settingsModal.hidden = true;
    } catch (err) {
      alert(`Update failed: ${err.message}`);
    }
    settingsDeployBtn.disabled = false;
    settingsDeployBtn.textContent = 'Pull latest & restart';
  });

  settingsRestartBtn.addEventListener('click', async () => {
    if (!confirm('Restart the chat service? All agents briefly disconnect (a few seconds) while it comes back up.')) {
      return;
    }
    settingsRestartBtn.disabled = true;
    settingsRestartBtn.textContent = 'Restarting…';
    try {
      await fetch('/api/restart', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // The server may already be tearing down by the time this rejects —
      // expected, not a real failure. Either way the connection banner
      // (reconnecting… → back online) is what actually shows progress.
    }
    settingsModal.hidden = true;
    settingsRestartBtn.disabled = false;
    settingsRestartBtn.textContent = 'Restart service';
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

// ---- Connection banner: visible across both the list and chat views
// (unlike the small #status text, which only lives in the list header) —
// specifically so a server restart/deploy is impossible to miss regardless
// of where you're looking in the app. "online" is only shown as a brief
// confirmation after an actual drop, never on the first-ever connect.
const connBannerEl = $('#connection-banner');
let everConnected = false;
let onlineBannerTimer = null;

function showConnBanner(text, kind) {
  clearTimeout(onlineBannerTimer);
  connBannerEl.className = kind;
  connBannerEl.innerHTML = `<span class="conn-dot"></span><span>${text}</span>`;
  connBannerEl.hidden = false;
}

function hideConnBanner() {
  connBannerEl.hidden = true;
}

function connBannerOnline() {
  clearTimeout(onlineBannerTimer);
  connBannerEl.className = 'online';
  connBannerEl.innerHTML = '<span class="conn-dot"></span><span>Back online</span>';
  connBannerEl.hidden = false;
  onlineBannerTimer = setTimeout(hideConnBanner, 2500);
}

function connectSocket(token) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    setStatus('connected', true);
    reconnectDelay = 1000;
    consecutiveAuthFailures = 0;
    hideAuthWarning();
    if (everConnected) connBannerOnline();
    else hideConnBanner();
    everConnected = true;
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
        hideConnBanner(); // the auth banner already covers this terminal state
        return;
      }
      setStatus('reconnecting…', false);
      showConnBanner('Reconnecting to server…', 'reconnecting');
      setTimeout(() => connectSocket(token), reconnectDelay);
      return;
    }
    if (ev.code === 4290) {
      setStatus('rate limited — waiting…', false);
      showConnBanner('Rate limited — waiting…', 'reconnecting');
      setTimeout(() => connectSocket(token), 60000);
      return;
    }
    setStatus('reconnecting…', false);
    showConnBanner('Reconnecting to server…', 'reconnecting');
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
      rooms.clear();
      for (const room of msg.rooms || []) rooms.set(room.id, room);
      if (!listViewEl.hidden) renderAgentList();
      setBadgeLocal(totalUnreadFromRoster());
      renderUsage(msg.usage);
      if (currentRoomId && !rooms.has(currentRoomId)) {
        showListView();
      } else if (currentRoomId) {
        // Same reasoning as the agent branch below: a whole discussion can
        // have run while the socket was dead, so re-fetch rather than trust
        // whatever is still on screen.
        openRoom(currentRoomId);
      } else if (currentAgentId && !roster.has(currentAgentId)) {
        showListView();
      } else if (currentAgentId) {
        // Reconnect while a chat was open — the socket may have been dead
        // for a while (backgrounded/suspended on iOS commonly kills it),
        // so the DOM's existing messages and work-indicator state can't be
        // trusted: a reply may have finished and broadcast while nothing
        // was listening. Re-fetch this agent's actual current state from
        // the server, exactly like freshly opening it, instead of trying
        // to patch up what's already on screen.
        openAgent(currentAgentId);
      }
      break;

    case 'roster_entry':
      roster.set(msg.agent.id, msg.agent);
      if (!listViewEl.hidden) renderAgentList();
      if (currentAgentId === msg.agent.id) {
        syncModelSelect(msg.agent);
        syncEffortSlider(msg.agent);
        // A model switch restarts this agent's bridge, which discards its
        // old context reading (a different model has a different context
        // window, so the old percentage would just be wrong) — reflect that
        // as "unknown, waiting for next check" rather than leaving the
        // previous model's stale number on screen.
        renderContextUsage(msg.agent.context);
      }
      setBadgeLocal(totalUnreadFromRoster());
      break;

    case 'context_update':
      if (msg.agentId === currentAgentId) renderContextUsage(msg.context);
      break;

    case 'usage_update':
      renderUsage(msg.usage);
      break;


    case 'todos_update':
      if (msg.agentId === currentAgentId) {
        currentTodos = msg.todos;
        renderTodoBadge(currentTodos);
        if (!todoModal.hidden) renderTodoList(currentTodos);
      }
      break;

    case 'room_entry': {
      rooms.set(msg.room.id, msg.room);
      if (!listViewEl.hidden) renderAgentList();
      // The member strip carries the live "who is replying" state, so it has
      // to re-render on every room_entry, not just on open.
      if (currentRoomId === msg.room.id) {
        renderRoomMembers(msg.room);
        updateSendButtonMode(); // busy-member count drives the send/stop toggle
      }
      setBadgeLocal(totalUnreadFromRoster());
      break;
    }

    case 'room_message':
      if (msg.roomId === currentRoomId) {
        if (!document.getElementById('m-' + msg.message.id)) {
          renderRoomMessage({ ...msg.message, sender: msg.message.agentId
            ? rooms.get(currentRoomId)?.members.find((m) => m.id === msg.message.agentId)?.name
            : 'You' });
          // Your own message always jumps to the bottom — you just sent it, so
          // that's unambiguously where you want to be. An agent's does not.
          if (msg.message.agentId) scrollToBottomIfPinned();
          else scrollToBottom();
        }
      }
      break;

    case 'room_removed':
      rooms.delete(msg.roomId);
      if (currentRoomId === msg.roomId) showListView();
      else if (!listViewEl.hidden) renderAgentList();
      saveDraft('room:' + msg.roomId, '');
      setBadgeLocal(totalUnreadFromRoster());
      break;

    case 'agent_removed':
      roster.delete(msg.agentId);
      if (currentAgentId === msg.agentId) showListView();
      else if (!listViewEl.hidden) renderAgentList();
      saveDraft(msg.agentId, ''); // purge — showListView() above may have just re-saved a stale one
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

    case 'thinking_start':
      if (msg.agentId === currentAgentId) {
        if (!liveBubble) startWorkIndicator(Date.now(), null);
        liveThinkingText = '';
        liveThinkingTokens = 0;
        setWorkLabel('Thinking');
        renderLiveThinking();
      }
      break;

    case 'thinking_delta':
      if (msg.agentId === currentAgentId) {
        if (!liveBubble) startWorkIndicator(Date.now(), null);
        if (msg.text) liveThinkingText += msg.text;
        liveThinkingTokens = msg.tokens || liveThinkingTokens;
        setWorkLabel('Thinking');
        renderLiveThinking();
      }
      break;

    case 'tool_use':
      if (msg.agentId === currentAgentId) {
        // Full detail (name + input) is still shown, collapsed, once the
        // finished assistant_message arrives — this is just the live label.
        startWorkIndicator(workStartTs ?? Date.now(), msg.name);
        // Also show live tool invocation in the chat
        createLiveTool(msg.id, msg.name, msg.input);
      }
      break;

    case 'tool_result':
      if (msg.agentId === currentAgentId) {
        setWorkLabel('Thinking');
        // Update the live tool with its result
        updateLiveTool(msg.toolUseId, msg.isError, msg.preview);
      }
      break;

    case 'waiting':
      // Hit the account's session limit — the server has already scheduled
      // an automatic resend for when it resets, nothing to do here but
      // reflect that in the live indicator (and the list row, via the
      // roster_entry that accompanies this).
      if (msg.agentId === currentAgentId) startWorkIndicator(workStartTs ?? Date.now(), null, msg.resumesAt);
      break;

    case 'compacting':
      if (msg.agentId === currentAgentId) {
        compactingSince = msg.startedAt;
        startWorkIndicator(msg.startedAt, null);
      }
      break;

    case 'compact_done':
      if (msg.agentId === currentAgentId) {
        compactingSince = null;
        liveBubble?.classList.remove('compacting');
        if (!msg.crashed) renderCompactSummary(msg);
      }
      break;

    case 'clear_done':
      // /clear's own reply is suppressed server-side when empty (the usual
      // case), so no 'assistant_message' arrives to stop the work indicator
      // — do it here instead, same as that case does.
      if (msg.agentId === currentAgentId) {
        stopWorkIndicator();
        clearLiveTools();
        if (!msg.crashed) renderCompactSummary(msg);
      }
      break;

    case 'turn_started':
      // The scheduled auto-retry just fired and resent the message — same
      // visual as a fresh send, just with no new user_message bubble to add.
      if (msg.agentId === currentAgentId) startWorkIndicator(Date.now(), null);
      break;

    case 'assistant_message':
      if (msg.agentId === currentAgentId) {
        stopWorkIndicator();
        // Clean up live tool elements — they'll be replaced by the final message
        clearLiveTools();
        if (!document.getElementById('m-' + msg.message.id)) renderMessage(msg.message);
        scrollToBottomIfPinned();
      }
      break;

    case 'system':
      if (msg.agentId === currentAgentId) stopWorkIndicator();
      setStatus(msg.text, false);
      break;

  }
}

let liveRawText = '';
let liveThinkingText = '';
let liveThinkingTokens = 0;
let workStartTs = null;
let workTimerId = null;
// Set while a /compact is in flight so the work indicator shows a specific
// compaction animation instead of a generic "Thinking". The CLI reports no
// progress during compaction, so this drives an indeterminate animation and
// an elapsed timer — never a fake percentage.
let compactingSince = null;

// Live tool tracking: toolUseId -> DOM element
const liveTools = new Map();

// ---- Live tool display: shows tool invocations and results as they happen,
// collapsed by default (like the persisted .tools block) so a run with many
// calls doesn't turn the feed into a wall of JSON — the name + live status
// stays visible in the summary, full input/result is one tap away.
function createLiveTool(toolUseId, name, input) {
  const el = document.createElement('div');
  el.className = 'msg assistant live-tool';
  el.id = 'tool-' + toolUseId;
  el.dataset.toolUseId = toolUseId;

  const bubble = document.createElement('div');
  bubble.className = 'bubble tool-bubble';

  const details = document.createElement('details');
  details.className = 'tool-details';

  const header = document.createElement('summary');
  header.className = 'tool-header';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;
  const statusEl = document.createElement('span');
  statusEl.className = 'tool-status running';
  statusEl.textContent = 'Running…';
  header.append(nameEl, statusEl);
  details.appendChild(header);

  const inputEl = document.createElement('pre');
  inputEl.className = 'tool-input';
  inputEl.textContent = JSON.stringify(input, null, 2);

  const resultEl = document.createElement('pre');
  resultEl.className = 'tool-result hidden';
  resultEl.textContent = 'Waiting for result…';

  details.append(inputEl, resultEl);
  bubble.appendChild(details);
  el.appendChild(bubble);
  messagesEl.appendChild(el);
  liveTools.set(toolUseId, el);
}

function updateLiveTool(toolUseId, isError, preview) {
  const el = liveTools.get(toolUseId);
  if (!el) return;
  const statusEl = el.querySelector('.tool-status');
  const resultEl = el.querySelector('.tool-result');
  if (statusEl) {
    statusEl.textContent = isError ? 'Error' : 'Done';
    statusEl.className = 'tool-status ' + (isError ? 'error' : 'done');
  }
  if (resultEl) {
    resultEl.textContent = typeof preview === 'string' ? preview : JSON.stringify(preview, null, 2);
    resultEl.classList.remove('hidden');
    if (isError) resultEl.classList.add('error');
  }
}

function clearLiveTools() {
  for (const el of liveTools.values()) {
    el.remove();
  }
  liveTools.clear();
}

// ---- Send/stop button: the composer's submit button becomes a stop
// button exactly when there'd be nothing else useful to submit anyway
// (the open agent is working, and you haven't typed a reply to queue up).
let composerMode = 'send';

function updateSendButtonMode() {
  // In a room the work isn't this screen's own turn — it's however many
  // members happen to be mid-reply, which only the roster knows about.
  const roomBusy = currentRoomId ? (rooms.get(currentRoomId)?.busyMemberIds?.length || 0) > 0 : false;
  const shouldStop = (currentRoomId ? roomBusy : workStartTs !== null) && inputEl.value.trim() === '';
  composerMode = shouldStop ? 'stop' : 'send';
  sendBtn.textContent = shouldStop ? '■' : '↑';
  sendBtn.classList.toggle('stop-mode', shouldStop);
  sendBtn.setAttribute('aria-label', shouldStop ? 'Stop' : 'Send');
}

function hideSlashSuggestions() {
  slashSuggestionsEl.hidden = true;
  slashSuggestionsEl.innerHTML = '';
}

// The list itself comes straight from the CLI's own session-init event
// (see claudeBridge.js) via the current agent's roster entry — never
// hardcoded here, so it can't go stale as Claude Code's own commands change.
// Hand-maintained, deliberately — there's no reliable automatic source for
// descriptions (unlike the command names themselves, which come straight
// from the CLI's own session-init event). Unknown commands just show their
// bare name with no description instead of a guess; ask to add one here
// when a new/unfamiliar command shows up in the list.
const SLASH_COMMAND_DESCRIPTIONS = {
  clear: 'Clear conversation history and start fresh',
  compact: 'Compact the conversation to free up context space',
  model: 'Switch the AI model for this session',
  config: 'View or change Claude Code settings',
  context: 'Show context window usage breakdown',
  mcp: 'Manage MCP server connections',
  agents: 'Manage background agents',
  doctor: 'Check the health of your Claude Code installation',
  init: 'Generate a CLAUDE.md file documenting this codebase',
  review: 'Review a GitHub pull request',
  'security-review': 'Security review of the pending changes on this branch',
  ultrareview: 'Cloud-hosted multi-agent code review of the current branch',
  'code-review': 'Review the working diff for quality issues',
  dataviz: 'Guidance for building charts, graphs, and dashboards',
  'update-config': 'Configure the Claude Code harness via settings.json',
  simplify: 'Review changed code for simplification and cleanup',
  'fewer-permission-prompts': 'Add an allowlist to reduce permission prompts',
  loop: 'Run a prompt or command on a recurring interval',
  schedule: 'Create or manage scheduled cloud agents',
  'claude-api': 'Reference for the Claude API / Anthropic SDK',
  run: "Launch and drive this project's app to test a change",
  fast: 'Toggle fast mode (faster output via Opus)',
  usage: 'Show usage and credit summary',
  rename: 'Rename this session',
  // Looked up from official docs.claude.com / code.claude.com docs, since
  // the CLI itself doesn't report descriptions (see the comment above).
  'design-sync': "Sync your repo's design system with Claude Design (two-way)",
  verify: 'Verify the app still works correctly (companion to /run)',
  debug: 'Enable debug logging for this session and troubleshoot issues',
  batch: 'Orchestrate large-scale changes across the codebase in parallel via subagents',
  color: 'Set the prompt bar color for this session',
  effort: "Set the model's reasoning effort level (low/medium/high/xhigh/max)",
  heapdump: 'Write a JS heap snapshot to ~/Desktop for diagnosing memory usage',
  insights: 'Generate a report analyzing your Claude Code session patterns',
  goal: 'Set a goal — Claude keeps working across turns until it is met',
  'usage-credits': 'View/manage usage credits to keep working past your plan limit',
  'extra-usage': 'View/manage usage credits to keep working past your plan limit',
  recap: 'Summarize session context when returning to it',
  'team-onboarding': 'Generate a teammate ramp-up guide from your local usage patterns',
  'run-skill-generator': 'Record how this app installs/runs and save it as a reusable skill',
  'reload-skills': 'Reload the skills directory without restarting Claude Code',
  design: 'Create, edit, and sync Claude Design projects from the terminal',
  // Inferred from the design-sync/design/design-login pattern, not directly
  // sourced — least confident two entries here, flag if wrong.
  'design-consent': 'Grant Claude Design access authorization',
  'design-revoke': 'Revoke Claude Design access authorization',
};

// @mention autocomplete, reusing the slash-suggestion strip. Restricted to
// this room's members: mentioning someone who isn't in the room resolves to
// nobody server-side, and offering the whole roster here would invite exactly
// that. Inserts the full name, which is what the server's parser matches most
// reliably when names contain spaces.
function updateMentionSuggestions() {
  const match = inputEl.value.match(/@([^@\s]*)$/);
  const members = rooms.get(currentRoomId)?.members || [];
  if (!match || !members.length) {
    hideSlashSuggestions();
    return;
  }

  const prefix = match[1].toLowerCase();
  const matches = members.filter((m) => m.name.toLowerCase().replace(/\s+/g, '').startsWith(prefix.replace(/\s+/g, '')));
  if (!matches.length) {
    hideSlashSuggestions();
    return;
  }

  slashSuggestionsEl.innerHTML = '';
  for (const m of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-suggestion';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-suggestion-name';
    nameEl.textContent = `${m.emoji || '🤖'} @${m.name}`;
    btn.appendChild(nameEl);

    if (m.blurb) {
      const descEl = document.createElement('span');
      descEl.className = 'slash-suggestion-desc';
      descEl.textContent = m.blurb;
      btn.appendChild(descEl);
    }

    btn.addEventListener('click', () => {
      inputEl.value = inputEl.value.replace(/@([^@\s]*)$/, `@${m.name} `);
      autoResizeInput();
      updateSendButtonMode();
      hideSlashSuggestions();
      inputEl.focus();
    });
    slashSuggestionsEl.appendChild(btn);
  }
  slashSuggestionsEl.hidden = false;
}

function updateSlashSuggestions() {
  // Only while composing the command name itself (no space yet) — once
  // there's a space the user's typing arguments, not searching for a command.
  const match = inputEl.value.match(/^\/(\S*)$/);
  const available = roster.get(currentAgentId)?.slashCommands || [];
  if (!match || !available.length) {
    hideSlashSuggestions();
    return;
  }

  const prefix = match[1].toLowerCase();
  const matches = available.filter((c) => c.toLowerCase().startsWith(prefix)); // scrollable now, no need to truncate
  if (!matches.length) {
    hideSlashSuggestions();
    return;
  }

  slashSuggestionsEl.innerHTML = '';
  for (const cmd of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-suggestion';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-suggestion-name';
    nameEl.textContent = '/' + cmd;
    btn.appendChild(nameEl);

    const description = SLASH_COMMAND_DESCRIPTIONS[cmd];
    if (description) {
      const descEl = document.createElement('span');
      descEl.className = 'slash-suggestion-desc';
      descEl.textContent = description;
      btn.appendChild(descEl);
    }

    btn.addEventListener('click', () => {
      inputEl.value = '/' + cmd + ' ';
      autoResizeInput();
      updateSendButtonMode();
      hideSlashSuggestions();
      inputEl.focus();
    });
    slashSuggestionsEl.appendChild(btn);
  }
  slashSuggestionsEl.hidden = false;
}

// ---- Working indicator: mirrors the CLI's "spinner + elapsed time" cue —
// otherwise there is no signal at all that a turn is in flight until either
// streamed text or the final message shows up, which can be many seconds
// (tool calls, thinking) of apparent silence. Only ever shown for the
// currently open agent; background agents show a working-dot in the list.
function formatResumeTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Session/week are genuinely account-wide — same figures regardless of which
// chat is open, since the underlying rate limits are shared across every
// agent. Context is NOT account-wide (each agent is a separate --resume'd
// conversation against its own context window) and is deliberately handled
// by a separate function below — folding it into this one was the bug
// behind every agent's context bar showing whichever agent last happened to
// be probed, instead of the one actually on screen.
function renderUsage(usage) {
  usageSessionFill.style.width = (usage?.session?.percent ?? 0) + "%";
  usageSessionBar.title = usage?.session
    ? `Session: ${usage.session.percent}% used · resets ${usage.session.resetsLabel}`
    : "";
  usageWeekFill.style.width = (usage?.week?.percent ?? 0) + "%";
  usageWeekBar.title = usage?.week
    ? `Week: ${usage.week.percent}% used · resets ${usage.week.resetsLabel}`
    : "";
}

// Renders the context bar for whichever agent is passed in — callers are
// responsible for only calling this with the currently *open* agent's
// reading (or null, e.g. right after a model switch discards the old
// reading and no new probe has landed yet), never a different agent's.
function renderContextUsage(context) {
  usageContextFill.style.width = (context?.percent ?? 0) + "%";
  usageContextBar.title = context
    ? `Context: ${context.percent}% used · ${context.tokensUsed}/${context.tokensTotal} tokens`
    : 'Context: unknown — waiting for next check';
}

function startWorkIndicator(startedAt, toolName, waitingUntil) {
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
        <details class="live-thinking" hidden>
          <summary class="live-thinking-summary"></summary>
          <div class="live-thinking-text"></div>
        </details>
        <div class="live-text"></div>
      </div>`;
    messagesEl.appendChild(liveBubble);
    liveRawText = '';
    liveThinkingText = '';
    liveThinkingTokens = 0;
    scrollToBottomIfPinned();
  }
  workStartTs = startedAt;
  liveBubble.classList.toggle('waiting', !!waitingUntil);
  if (waitingUntil) {
    // Ticking seconds is useful for "how long has this been thinking";
    // it's meaningless for "will resume in a few hours" — show a plain
    // target time instead and stop the per-second timer.
    setWorkLabel(`Rate limited — resumes ${formatResumeTime(waitingUntil)}`);
    if (workTimerId) {
      clearInterval(workTimerId);
      workTimerId = null;
    }
    const timeEl = liveBubble.querySelector('.work-time');
    if (timeEl) timeEl.textContent = '';
  } else if (compactingSince) {
    setWorkLabel('Compacting conversation');
    updateWorkTimer();
    if (!workTimerId) workTimerId = setInterval(updateWorkTimer, 1000);
  } else {
    setWorkLabel(toolName ? `Running ${toolName}` : 'Thinking');
    updateWorkTimer();
    if (!workTimerId) workTimerId = setInterval(updateWorkTimer, 1000);
  }
  liveBubble.classList.toggle('compacting', !!compactingSince);
  updateSendButtonMode();
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
  const liveTextEl = liveBubble.querySelector('.live-text');
  liveTextEl.innerHTML = renderMarkdown(extractOptions(liveRawText).cleanText);
  addCodeCopyButtons(liveTextEl);
  scrollToBottomIfPinned();
}

// Renders thinking as it streams in, so opening the app mid-turn shows what
// was already reasoned through rather than just a bare "Thinking" label with
// no history. Anthropic-native models redact the actual text server-side —
// only a running token estimate ever arrives for those — so this always
// shows *something* live (text when available, a token count otherwise)
// rather than going silent depending on which model happens to be active.
function renderLiveThinking() {
  if (!liveBubble) return;
  const details = liveBubble.querySelector('.live-thinking');
  const summary = liveBubble.querySelector('.live-thinking-summary');
  const textEl = liveBubble.querySelector('.live-thinking-text');
  if (!details || !summary || !textEl) return;

  const hasText = liveThinkingText.length > 0;
  const hasTokens = liveThinkingTokens > 0;
  if (!hasText && !hasTokens) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  // Token estimates and streamed text come from mutually exclusive sources
  // (see thinking_delta in claudeBridge.js): Anthropic-native models redact
  // the text and only ever report tokens; OpenRouter models stream real text
  // and never report a token estimate. Prefer whichever signal actually
  // showed up rather than assuming both are always present together.
  summary.textContent = hasTokens
    ? `Thinking… (~${formatCompactTokens(liveThinkingTokens)} tokens)`
    : `Thinking… (${liveThinkingText.length} chars)`;
  if (hasText) textEl.textContent = liveThinkingText;
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
  liveThinkingText = '';
  liveThinkingTokens = 0;
  compactingSince = null;
  updateSendButtonMode();
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
  liveThinkingText = '';
  liveThinkingTokens = 0;
  compactingSince = null;
  clearLiveTools();
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

// Small copy button pinned to the corner of each code block, separate from
// the whole-message copy button — for grabbing just one snippet out of a
// reply that mixes prose and code, without the surrounding text.
function addCodeCopyButtons(container) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.querySelector('.code-copy-btn')) continue; // already has one
    const code = pre.querySelector('code');
    if (!code) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = COPY_ICON;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.innerHTML = CHECK_ICON;
        btn.classList.add('copied');
      } catch {
        btn.innerHTML = COPY_ICON;
      }
      setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove('copied');
      }, 1500);
    });

    pre.appendChild(btn);
  }
}

// Collapsed record of a finished turn's thinking, styled like the existing
// collapsed tools block and placed just before it (thinking precedes tool
// calls chronologically). '' text with a token count still renders — that's
// the normal, non-broken case for Anthropic-native models, which redact the
// actual text server-side; showing nothing there would look identical to a
// turn that didn't think at all.
function buildThinkingDetails(text, tokens) {
  if (!text && !tokens) return null;
  const details = document.createElement('details');
  details.className = 'tools thinking-details';
  const summary = document.createElement('summary');
  summary.textContent = text
    ? `Thinking${tokens ? ` (${formatCompactTokens(tokens)} tokens)` : ''}`
    : `Thinking (~${formatCompactTokens(tokens)} tokens, not shown by this model)`;
  details.appendChild(summary);
  if (text) {
    const pre = document.createElement('div');
    pre.className = 'tool-line thinking-text';
    pre.textContent = text;
    details.appendChild(pre);
  }
  return details;
}

// Left in an agent's own DM whenever a turn's reply went to a room instead —
// otherwise its chat shows an unexplained gap where it was clearly busy, with
// no way to find out what it actually said.
function buildRoomRefEl(m) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'msg room-ref';
  if (m.id) el.id = 'm-' + m.id;

  const title = document.createElement('div');
  title.className = 'room-ref-title';
  title.textContent = `${m.roomEmoji || '👥'} Replied in ${m.roomName ? '#' + m.roomName : 'a group chat'}`;
  el.appendChild(title);

  if (m.preview) {
    const preview = document.createElement('div');
    preview.className = 'room-ref-preview';
    preview.textContent = m.preview;
    el.appendChild(preview);
  }

  el.addEventListener('click', () => {
    if (m.roomId && rooms.has(m.roomId)) openRoom(m.roomId);
  });
  return el;
}

function renderMessage(m) {
  if (m.role === 'room-ref') {
    messagesEl.appendChild(buildRoomRefEl(m));
    return;
  }
  if (m.role === 'compact-summary' || m.role === 'clear-summary') {
    messagesEl.appendChild(buildCompactSummaryEl(m));
    return;
  }

  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.id = 'm-' + m.id;

  const { cleanText, options } = extractOptions(m.text);

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (m.isError ? ' error' : '');
  bubble.innerHTML = renderMarkdown(cleanText);
  addCodeCopyButtons(bubble);
  el.appendChild(bubble);

  if (options.length) el.appendChild(buildOptionButtons(options));

  el.appendChild(buildCopyButton(cleanText));

  const thinkingDetails = buildThinkingDetails(m.thinking, m.thinkingTokens);
  if (thinkingDetails) el.appendChild(thinkingDetails);

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

  // Collapsible error details for failed messages
  if (m.isError && cleanText) {
    const details = document.createElement('details');
    details.className = 'error-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Show error details';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = cleanText;
    details.appendChild(pre);
    el.appendChild(details);
  }

  messagesEl.appendChild(el);
}

// The end-of-compaction marker. Compaction is otherwise completely silent —
// no progress events, no reply text — so without this the only cue that it
// finished is the indicator vanishing. Figures shown are measured, never
// estimated: elapsed time, and the before/after context reading from the
// probe that runs right after the turn. A missing "after" reading (probe
// failed to parse) degrades to just the duration rather than a wrong number.
function formatCompactTokens(n) {
  if (!Number.isFinite(n)) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Shared by the /compact and /clear end-of-turn markers \u2014 both report a
// measured before/after context reading the same way, differing only in
// wording (msg.role picks which).
function buildCompactSummaryEl(msg) {
  const isClear = msg.role === 'clear-summary';

  const el = document.createElement('div');
  el.className = `msg ${msg.role}`;
  if (msg.id) el.id = 'm-' + msg.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const secs = Math.max(0, Math.round((msg.durationMs || 0) / 1000));
  const took = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;

  const before = formatCompactTokens(msg.tokensBefore);
  const after = formatCompactTokens(msg.tokensAfter);

  const noun = isClear ? 'Clear' : 'Compaction';
  let headline;
  if (msg.isError) headline = `\u26a0\ufe0f ${noun} failed`;
  else if (msg.wasInterrupted) headline = `\u26a0\ufe0f ${noun} stopped`;
  else headline = isClear ? '\u2713 Conversation cleared' : '\u2713 Conversation compacted';

  const title = document.createElement('div');
  title.className = 'summary-title';
  title.textContent = headline;
  bubble.appendChild(title);

  const detail = document.createElement('div');
  detail.className = 'summary-detail';
  if (!msg.isError && !msg.wasInterrupted && before && after) {
    const freed = msg.tokensBefore - msg.tokensAfter;
    const pct = msg.tokensBefore > 0 ? Math.round((freed / msg.tokensBefore) * 100) : 0;
    detail.textContent = freed > 0
      ? `${before} \u2192 ${after} tokens \u00b7 freed ${formatCompactTokens(freed)} (${pct}%) \u00b7 took ${took}`
      : `${before} \u2192 ${after} tokens \u00b7 took ${took}`;
  } else if (!msg.isError && !msg.wasInterrupted && after) {
    detail.textContent = `now at ${after} tokens\u00a0\u00b7 took ${took}`;
  } else {
    detail.textContent = `took ${took}`;
  }
  bubble.appendChild(detail);

  el.appendChild(bubble);
  return el;
}

// Live path: the compact_done WS event fires the instant a /compact finishes,
// well before the persisted copy could round-trip through a history reload.
function renderCompactSummary(msg) {
  messagesEl.appendChild(buildCompactSummaryEl(msg));
  scrollToBottomIfPinned();
}

// ---- Scroll anchoring -----------------------------------------------------
// Arriving messages used to force the feed to the bottom unconditionally,
// which makes reading anything mid-conversation impossible: a long agent reply
// streams in token by token and yanks the view away on every chunk. Instead,
// follow the bottom only while the reader is already there.
//
// The flag is only ever updated from real scroll events. Appending content
// does not fire a scroll event, so a flag captured before the append still
// describes what the reader wanted — which is exactly the question being
// asked here.
const SCROLL_PIN_THRESHOLD = 80; // px of slack, so "close enough" still counts as pinned
let pinnedToBottom = true;

function distanceFromBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  pinnedToBottom = true;
  updateJumpToLatest();
}

// For anything the reader didn't ask for: new replies, streaming text, tool
// output. Their own sends still scroll unconditionally.
function scrollToBottomIfPinned() {
  if (pinnedToBottom) scrollToBottom();
  else updateJumpToLatest();
}

function updateJumpToLatest() {
  // Without this, scrolling up to read means new arrivals are silent and
  // off-screen — the pill is what makes "don't follow automatically" safe
  // rather than just quiet.
  jumpToLatestBtn.hidden = pinnedToBottom || !!chatViewEl.hidden;
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
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (currentRoomId) {
    ws.send(JSON.stringify({ type: 'room_message', roomId: currentRoomId, text: trimmed }));
  } else if (currentAgentId) {
    ws.send(JSON.stringify({ type: 'message', agentId: currentAgentId, text: trimmed }));
  }
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  if (composerMode === 'stop') {
    if (currentRoomId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room_stop', roomId: currentRoomId }));
    } else if (currentAgentId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop', agentId: currentAgentId }));
    }
    return;
  }
  sendMessage(inputEl.value);
  inputEl.value = '';
  autoResizeInput();
  saveDraft(currentRoomId ? 'room:' + currentRoomId : currentAgentId, ''); // sent — no longer a draft
  updateSendButtonMode();
  hideSlashSuggestions();
});

let draftSaveTimer = null;
inputEl.addEventListener('input', () => {
  autoResizeInput();
  updateSendButtonMode();
  if (currentRoomId) updateMentionSuggestions();
  else updateSlashSuggestions();
  // Debounced so every keystroke doesn't hit localStorage, but short enough
  // that backgrounding the app moments after typing still catches it —
  // the visibilitychange/pagehide flushes below are the hard guarantee.
  clearTimeout(draftSaveTimer);
  const draftKey = currentRoomId ? 'room:' + currentRoomId : currentAgentId;
  draftSaveTimer = setTimeout(() => saveDraft(draftKey, inputEl.value), 300);
});

// ---- Visibility -> badge + read receipts ----
function setupVisibility(token) {
  // Hard guarantee for the draft, independent of the debounce above — these
  // fire right as the app backgrounds/suspends, which on iOS is often the
  // last guaranteed chance to run any code before the process gets killed.
  const flushDraft = () => currentAgentId && saveDraft(currentAgentId, inputEl.value);
  window.addEventListener('pagehide', flushDraft);

  document.addEventListener('visibilitychange', () => {
    const visible = !document.hidden;
    if (!visible) flushDraft();
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

  navigator.serviceWorker?.addEventListener('message', async (event) => {
    if (event.data?.type === 'notification-click') {
      const targetRoomId = event.data.roomId;
      const targetAgentId = event.data.agentId;
      // A room notification wins: it's only ever sent when a discussion came
      // to rest and handed the thread back, which is the thing worth opening.
      if (targetRoomId) {
        if (!rooms.has(targetRoomId)) {
          try {
            const res = await fetch('/api/roster', { headers: { Authorization: `Bearer ${currentToken}` } });
            const data = await res.json();
            for (const r of data.rooms || []) rooms.set(r.id, r);
          } catch {
            /* offline — fall through to the badge-only fallback below */
          }
        }
        if (rooms.has(targetRoomId)) openRoom(targetRoomId);
        else setBadgeLocal(totalUnreadFromRoster());
        return;
      }
      if (!targetAgentId) {
        setBadgeLocal(totalUnreadFromRoster());
        return;
      }
      // The in-memory roster can be stale by the time this fires — e.g. the
      // tap resumed a page that had been backgrounded (and disconnected)
      // long enough that the roster snapshot in memory predates the agent,
      // or predates whichever tab/reconnect last refreshed it. One retry
      // against a fresh fetch before giving up, rather than silently
      // stranding the user on whatever conversation happened to be open.
      if (!roster.has(targetAgentId)) {
        try {
          const res = await fetch('/api/roster', { headers: { Authorization: `Bearer ${currentToken}` } });
          const data = await res.json();
          for (const a of data.agents) roster.set(a.id, a);
        } catch {
          /* offline — fall through to the badge-only fallback below */
        }
      }
      if (roster.has(targetAgentId)) {
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
