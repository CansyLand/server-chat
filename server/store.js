import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  sessionId: null,
  messages: [], // { id, role: 'user'|'assistant', text, ts, tools: [...], isError }
  pushSubscription: null,
  unreadCount: 0,
  paired: false,
};

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

let state = load();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }, 100);
}

export const store = {
  get sessionId() {
    return state.sessionId;
  },
  setSessionId(id) {
    state.sessionId = id;
    save();
  },
  getMessages() {
    return state.messages;
  },
  addMessage(msg) {
    state.messages.push(msg);
    // Keep history bounded; Claude's own session file is the durable record.
    if (state.messages.length > 500) state.messages.shift();
    save();
  },
  getUnreadCount() {
    return state.unreadCount;
  },
  incrementUnread() {
    state.unreadCount += 1;
    save();
    return state.unreadCount;
  },
  clearUnread() {
    state.unreadCount = 0;
    save();
  },
  getPushSubscription() {
    return state.pushSubscription;
  },
  setPushSubscription(sub) {
    state.pushSubscription = sub;
    save();
  },
  isPaired() {
    return state.paired;
  },
  setPaired(value) {
    state.paired = value;
    save();
  },
};
