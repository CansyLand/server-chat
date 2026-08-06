import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');

function messagesFile(agentId) {
  return path.join(DATA_DIR, `agent-${agentId}-messages.json`);
}

function roomMessagesFile(roomId) {
  return path.join(DATA_DIR, `room-${roomId}-messages.json`);
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
let roomsState = readJson(ROOMS_FILE, { rooms: [] });
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

function saveRooms() {
  debounced('rooms', () => writeJson(ROOMS_FILE, roomsState));
}

const roomMessageState = new Map(); // roomId -> { messages, unreadCount }

function loadRoomMessages(roomId) {
  if (!roomMessageState.has(roomId)) {
    roomMessageState.set(roomId, readJson(roomMessagesFile(roomId), { messages: [], unreadCount: 0 }));
  }
  return roomMessageState.get(roomId);
}

function saveRoomMessages(roomId) {
  debounced(`room-messages:${roomId}`, () => writeJson(roomMessagesFile(roomId), loadRoomMessages(roomId)));
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
  createAgent({ name, emoji, color, workdir, systemPrompt, model, provider, effort, blurb }) {
    const agent = {
      id: randomUUID().slice(0, 8),
      name,
      emoji,
      color,
      workdir,
      systemPrompt: systemPrompt || null,
      // One line of "what I'm the expert in", shown to *other* agents — in
      // their system prompt and in every group-chat delivery header. Distinct
      // from systemPrompt, which is this agent's own private instructions and
      // is far too long (and often too specific) to hand to everyone else.
      blurb: blurb || null,
      model: model || null,
      provider: provider || null,
      effort: effort || null,
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
    // A deleted agent must not linger as a phantom member: rooms would keep
    // listing it, and @mentions of its name would resolve to nothing.
    for (const room of roomsState.rooms) {
      const memberIdx = room.memberIds.indexOf(id);
      if (memberIdx !== -1) room.memberIds.splice(memberIdx, 1);
      delete room.seen[id];
    }
    saveRooms();
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

  // ---- rooms: group chats holding several agents plus the human. A room is
  // purely a delivery mechanism — it owns no Claude process of its own. Each
  // member keeps its single existing session; the room just decides whose
  // session a given message gets fed into. ----
  listRooms() {
    return roomsState.rooms;
  },
  getRoom(id) {
    return roomsState.rooms.find((r) => r.id === id) || null;
  },
  createRoom({ name, emoji, color, charter, memberIds }) {
    const room = {
      id: randomUUID().slice(0, 8),
      name,
      emoji: emoji || '👥',
      color: color || '#7c9cff',
      charter: charter || null,
      memberIds: memberIds || [],
      // Per-member high-water mark of the room transcript already folded into
      // that agent's session (by message seq, not array index — the transcript
      // is trimmed at the front, which would silently shift indices).
      seen: {},
      nextSeq: 1,
      brief: null,
      briefSeq: 0, // transcript position the brief already reflects
      createdAt: Date.now(),
    };
    roomsState.rooms.push(room);
    saveRooms();
    return room;
  },
  updateRoom(id, patch) {
    const room = this.getRoom(id);
    if (!room) return null;
    Object.assign(room, patch);
    saveRooms();
    return room;
  },
  removeRoom(id) {
    const idx = roomsState.rooms.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    roomsState.rooms.splice(idx, 1);
    saveRooms();
    roomMessageState.delete(id);
    try {
      fs.unlinkSync(roomMessagesFile(id));
    } catch {
      /* never written — fine */
    }
    return true;
  },

  getRoomMessages(roomId) {
    return loadRoomMessages(roomId).messages;
  },
  addRoomMessage(roomId, msg) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const stored = { ...msg, seq: room.nextSeq };
    room.nextSeq += 1;
    saveRooms();
    const s = loadRoomMessages(roomId);
    s.messages.push(stored);
    if (s.messages.length > 500) s.messages.shift();
    saveRoomMessages(roomId);
    return stored;
  },

  // How far through the room transcript this agent's session has been brought
  // up to date. Messages past this point are the "catch-up" block prepended to
  // the next thing that agent is actually asked to answer — which is how a
  // member that wasn't @mentioned still ends up having read the whole
  // discussion, without burning a turn per message.
  getRoomSeen(roomId, agentId) {
    return this.getRoom(roomId)?.seen[agentId] || 0;
  },
  setRoomSeen(roomId, agentId, seq) {
    const room = this.getRoom(roomId);
    if (!room) return;
    room.seen[agentId] = seq;
    saveRooms();
  },

  // The running brief: what the room is working on and why. Written by a
  // separate model call seconds behind the transcript, so it lives beside the
  // messages rather than inside them — the discussion must never wait on it.
  // briefSeq is how far through the transcript the brief already accounts for.
  getRoomBrief(roomId) {
    return this.getRoom(roomId)?.brief || null;
  },
  setRoomBrief(roomId, brief) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    room.brief = { ...brief, updatedAt: Date.now() };
    saveRooms();
    return room.brief;
  },

  getRoomUnread(roomId) {
    return loadRoomMessages(roomId).unreadCount;
  },
  incrementRoomUnread(roomId) {
    const s = loadRoomMessages(roomId);
    s.unreadCount += 1;
    saveRoomMessages(roomId);
    return s.unreadCount;
  },
  clearRoomUnread(roomId) {
    const s = loadRoomMessages(roomId);
    if (s.unreadCount !== 0) {
      s.unreadCount = 0;
      saveRoomMessages(roomId);
    }
  },
};
