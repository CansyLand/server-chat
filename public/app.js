const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
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
  let vapidPublicKey = null;
  try {
    const res = await fetch('/api/history', { headers: { Authorization: `Bearer ${token}` } });
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
      for (const m of data.messages) renderMessage(m);
      scrollToBottom();
      setBadgeLocal(data.unreadCount);
    }
  } catch (err) {
    setStatus('offline — retrying…', false);
  }

  connectSocket(token);
  setupNotifications(token, vapidPublicKey);
  setupVisibility(token);
  setupSettings(token);
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
      messagesEl.innerHTML = '';
      for (const m of msg.messages) renderMessage(m);
      scrollToBottom();
      setBadgeLocal(msg.unreadCount);
      break;
    case 'user_message':
      if (!document.getElementById('m-' + msg.message.id)) renderMessage(msg.message);
      scrollToBottom();
      break;
    case 'delta':
      appendLiveDelta(msg.text);
      break;
    case 'tool_use':
    case 'tool_result':
      // Intentionally not rendered live — full detail arrives (hidden by
      // default) with the finished assistant_message.
      break;
    case 'assistant_message':
      clearLiveBubble();
      if (!document.getElementById('m-' + msg.message.id)) renderMessage(msg.message);
      scrollToBottom();
      setBadgeLocal(0); // this client is connected & about to see it
      break;
    case 'system':
      setStatus(msg.text, false);
      break;
  }
}

let liveRawText = '';

function appendLiveDelta(text) {
  if (!liveBubble) {
    liveBubble = document.createElement('div');
    liveBubble.className = 'msg assistant live';
    liveBubble.innerHTML = '<div class="bubble"></div>';
    messagesEl.appendChild(liveBubble);
    liveRawText = '';
  }
  liveRawText += text;
  liveBubble.querySelector('.bubble').innerHTML = renderMarkdown(liveRawText);
  scrollToBottom();
}

function clearLiveBubble() {
  if (liveBubble) {
    liveBubble.remove();
    liveBubble = null;
    liveRawText = '';
  }
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

function renderMessage(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.id = 'm-' + m.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (m.isError ? ' error' : '');
  bubble.innerHTML = renderMarkdown(m.text);
  el.appendChild(bubble);

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
formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'message', text }));
  inputEl.value = '';
  inputEl.style.height = 'auto';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
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
      setBadgeLocal(0);
      fetch('/api/read', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
  });

  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'notification-click') {
      setBadgeLocal(0);
      fetch('/api/read', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
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
