import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');

function messagesFile(agentId) {
  return path.join(DATA_DIR, `agent-${agentId}-messages.json`);
}

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- One-time migration from the old single-conversation layout. Runs at
// most once ever: it's skipped the moment agents.json exists. The legacy
// file is renamed, never deleted, so this is trivially reversible if
// anything about the migration turns out wrong. ----
function migrateLegacyIfNeeded() {
  if (fs.existsSync(AGENTS_FILE)) return;
  if (!fs.existsSync(LEGACY_STATE_FILE)) return;

  const legacy = readJson(LEGACY_STATE_FILE, {
    sessionId: null,
    messages: [],
    pushSubscription: null,
    unreadCount: 0,
    paired: false,
  });

  const agentId = 'builder';
  writeJson(AGENTS_FILE, {
    agents: [
      {
        id: agentId,
        name: 'Builder',
        emoji: '🛠️',
        color: '#7c9cff',
        workdir: process.env.CLAUDE_WORKDIR || process.env.HOME,
        systemPrompt: null,
        sessionId: legacy.sessionId,
        createdAt: Date.now(),
      },
    ],
  });
  writeJson(messagesFile(agentId), {
    messages: legacy.messages,
    unreadCount: legacy.unreadCount,
  });
  writeJson(DEVICE_FILE, {
    paired: legacy.paired,
    pushSubscription: legacy.pushSubscription,
  });
  fs.renameSync(LEGACY_STATE_FILE, LEGACY_STATE_FILE + '.migrated');
}

migrateLegacyIfNeeded();

let agentsState = readJson(AGENTS_FILE, { agents: [] });
let deviceState = readJson(DEVICE_FILE, { paired: false, pushSubscription: null });
const messageState = new Map(); // agentId -> { messages, unreadCount }
const saveTimers = new Map(); // debounce key -> timeout handle

function debounced(key, fn) {
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(fn, 100));
}

function saveAgents() {
  debounced('agents', () => writeJson(AGENTS_FILE, agentsState));
}

function saveDevice() {
  debounced('device', () => writeJson(DEVICE_FILE, deviceState));
}

function loadMessages(agentId) {
  if (!messageState.has(agentId)) {
    messageState.set(agentId, readJson(messagesFile(agentId), { messages: [], unreadCount: 0 }));
  }
  return messageState.get(agentId);
}

function saveMessages(agentId) {
  debounced(`messages:${agentId}`, () => writeJson(messagesFile(agentId), loadMessages(agentId)));
}

export const store = {
  // ---- device: pairing + push subscription belong to the physical device,
  // not to any one agent — a device stays paired across every agent it talks to.
  isPaired() {
    return deviceState.paired;
  },
  setPaired(value) {
    deviceState.paired = value;
    saveDevice();
  },
  getPushSubscription() {
    return deviceState.pushSubscription;
  },
  setPushSubscription(sub) {
    deviceState.pushSubscription = sub;
    saveDevice();
  },

  // ---- agents ----
  listAgents() {
    return agentsState.agents;
  },
  getAgent(id) {
    return agentsState.agents.find((a) => a.id === id) || null;
  },
  createAgent({ name, emoji, color, workdir, systemPrompt }) {
    const agent = {
      id: randomUUID().slice(0, 8),
      name,
      emoji,
      color,
      workdir,
      systemPrompt: systemPrompt || null,
      sessionId: null,
      createdAt: Date.now(),
    };
    agentsState.agents.push(agent);
    saveAgents();
    return agent;
  },
  setAgentSessionId(id, sessionId) {
    const agent = this.getAgent(id);
    if (agent) {
      agent.sessionId = sessionId;
      saveAgents();
    }
  },

  // ---- per-agent messages ----
  getMessages(agentId) {
    return loadMessages(agentId).messages;
  },
  addMessage(agentId, msg) {
    const s = loadMessages(agentId);
    s.messages.push(msg);
    // Keep history bounded; Claude's own session file is the durable record.
    if (s.messages.length > 500) s.messages.shift();
    saveMessages(agentId);
  },
  getUnreadCount(agentId) {
    return loadMessages(agentId).unreadCount;
  },
  incrementUnread(agentId) {
    const s = loadMessages(agentId);
    s.unreadCount += 1;
    saveMessages(agentId);
    return s.unreadCount;
  },
  clearUnread(agentId) {
    const s = loadMessages(agentId);
    if (s.unreadCount !== 0) {
      s.unreadCount = 0;
      saveMessages(agentId);
    }
  },
};
