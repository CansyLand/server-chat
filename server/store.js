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

function todosFile(agentId) {
  return path.join(DATA_DIR, `agent-${agentId}-todos.json`);
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
        model: null,
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

const todoState = new Map(); // agentId -> { todos: [] }

function loadTodos(agentId) {
  if (!todoState.has(agentId)) {
    todoState.set(agentId, readJson(todosFile(agentId), { todos: [] }));
  }
  return todoState.get(agentId);
}

function saveTodos(agentId) {
  debounced(`todos:${agentId}`, () => writeJson(todosFile(agentId), loadTodos(agentId)));
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
  createAgent({ name, emoji, color, workdir, systemPrompt, model, provider }) {
    const agent = {
      id: randomUUID().slice(0, 8),
      name,
      emoji,
      color,
      workdir,
      systemPrompt: systemPrompt || null,
      model: model || null,
      provider: provider || null,
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
  updateAgent(id, patch) {
    const agent = this.getAgent(id);
    if (!agent) return null;
    Object.assign(agent, patch);
    saveAgents();
    return agent;
  },
  removeAgent(id) {
    const idx = agentsState.agents.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    agentsState.agents.splice(idx, 1);
    saveAgents();
    messageState.delete(id);
    todoState.delete(id);
    for (const file of [messagesFile(id), todosFile(id)]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone / never written — fine */
      }
    }
    return true;
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

  // ---- per-agent todos: a lightweight task list, separate from chat
  // history. Order is just array order — reordering means moving an
  // element, not a separate sort field. ----
  getTodos(agentId) {
    return loadTodos(agentId).todos;
  },
  addTodo(agentId, text) {
    const todo = {
      id: randomUUID().slice(0, 8),
      text,
      status: 'open', // 'open' | 'done' — removal is a separate, explicit step
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    loadTodos(agentId).todos.push(todo);
    saveTodos(agentId);
    return todo;
  },
  updateTodo(agentId, todoId, patch) {
    const todo = loadTodos(agentId).todos.find((t) => t.id === todoId);
    if (!todo) return null;
    Object.assign(todo, patch, { updatedAt: Date.now() });
    saveTodos(agentId);
    return todo;
  },
  moveTodo(agentId, todoId, direction) {
    const list = loadTodos(agentId).todos;
    const idx = list.findIndex((t) => t.id === todoId);
    if (idx === -1) return false;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= list.length) return false;
    [list[idx], list[swapIdx]] = [list[swapIdx], list[idx]];
    saveTodos(agentId);
    return true;
  },
  removeTodo(agentId, todoId) {
    const list = loadTodos(agentId).todos;
    const idx = list.findIndex((t) => t.id === todoId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    saveTodos(agentId);
    return true;
  },
};
