# Agent-facing docs for this app

This file is for the Claude Code agent(s) running behind this chat app — not
for the human. It ships with the repo, so every install of this app (any
Linux account, any server) has it automatically the moment the code is
cloned/pulled and the service restarts — no manual per-account setup step.

Every agent gets a system prompt telling it its own agent id/name, this
app's exact base URL, and the exact path to its auth token file — all
computed per-install, so nothing below needs editing per deployment.
This file covers the parts that don't change between installs: the
endpoint shapes and the intended workflow.

## What must never be committed to this repo

Agent definitions — names, personas/system prompts, working directories — live
in `data/agents.json`, which is gitignored and install-local. So do the
`data/*.secret` credential files. That is deliberate: this repo is pulled onto
unrelated machines running unrelated projects, and one operator's agent roster
must never turn up in someone else's checkout.

So: never commit agent identities, host-specific paths, or the workflows of
whatever project this install happens to serve. Project-specific instructions
belong in *that* project's own repo (or in a `CLAUDE.md` outside this one) —
never here. Anything you add to this file ships to every install, so it must be
true for all of them.

## Task list (todo) API

Every agent has its own task list, separate from chat history, visible to
the human as a round checkmark button in that agent's chat view in the UI.

Use your own agent id (from your system prompt) and this app's base URL +
token path (also from your system prompt) like this:

```bash
TOKEN=$(cat <token-path-from-your-system-prompt>)
AGENT_ID=<your own id, from your system prompt>
BASE=<base-url-from-your-system-prompt>

# List your tasks
curl -s $BASE/api/agents/$AGENT_ID/todos -H "Authorization: Bearer $TOKEN"

# Add one
curl -s -X POST $BASE/api/agents/$AGENT_ID/todos \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Task description"}'

# Mark done (status is "open" or "done")
curl -s -X PATCH $BASE/api/agents/$AGENT_ID/todos/<todo-id> \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"done"}'

# Reorder (direction is "up" or "down" — swaps with the neighbor)
curl -s -X POST $BASE/api/agents/$AGENT_ID/todos/<todo-id>/move \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"direction":"up"}'

# Delete
curl -s -X DELETE $BASE/api/agents/$AGENT_ID/todos/<todo-id> \
  -H "Authorization: Bearer $TOKEN"
```

**Workflow:** add tasks when starting a multi-step piece of work, mark each
`done` as you actually finish it. Don't delete tasks yourself — deletion is
the human's explicit "I verified this and it's really done" step. Updates
you make show up live in the human's open panel immediately, no refresh
needed.

---

## Group chats (rooms)

A room is a shared conversation between the human and a hand-picked set of
agents. It exists so specialists can work a problem out directly instead of
the human relaying messages between them.

**You do not get a second session for a room.** Room messages arrive in the
same conversation you're reading now, prefixed with `[Group chat #name]`, and
carry the room's purpose plus its current member list. That's deliberate: you
keep everything you already knew from your own chat.

### How to speak in a room

**Just reply.** When a room message is delivered to you, whatever your turn
produces is posted into that room automatically. No API call, no tool.

Write the reply *as a message to the room* — other agents read it, not just
the human. Keep it short. A wall of text is a wall of text for four readers.

### Addressing someone

`@Name` (their full name as shown in the member list) hands them the next
turn. Rules that matter:

- **Only @mentioned members are woken.** Everyone else in the room has your
  message folded into their *next* turn as catch-up, so they stay in sync
  without spending a turn on every line. You never need to "cc" anyone.
- **`@all`** (or `@everyone` / `@room`) addresses every member at once. Use it
  sparingly — it costs one turn per member, and every one of them replies. It's
  for "does anyone see a problem with this?", not for keeping people informed;
  catch-up already does that.
- **Mention someone when you want them to act or answer.** If the discussion
  is finished, reply without mentioning anyone — that's the signal that hands
  the thread back to the human, and it's what triggers their notification.
- You cannot @mention yourself, and mentioning a non-member does nothing.
- After 12 consecutive agent-to-agent hops with no human message, mentions
  stop being delivered and the room says so. Anything the human sends resets
  that counter.

### Working together without clobbering each other

Shared context is not the same as shared safety. Two agents editing the same
file ninety seconds apart still lose work. In a room:

- Say which files or directories you're about to touch, before you touch them.
- If someone else has claimed a file, ask in the room rather than editing it.
- Prefer disjoint working directories; if you genuinely need the same repo,
  agree on who commits.

### API

Replying needs none of this. Use it to read a room, or to start a thread
nobody prompted you for.

```bash
TOKEN=$(cat <token-path-from-your-system-prompt>)
BASE=<base-url-from-your-system-prompt>

# Rooms on this install (members, purpose, who's mid-reply)
curl -s $BASE/api/rooms -H "Authorization: Bearer $TOKEN"

# One room's transcript
curl -s $BASE/api/rooms/<room-id>/messages -H "Authorization: Bearer $TOKEN"

# Post to a room you're a member of (agentId = your own id)
curl -s -X POST $BASE/api/rooms/<room-id>/messages \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"agentId":"<your-id>","text":"@Someone here is what I found"}'
```

Rooms are created and staffed by the human, not by agents — who belongs in a
room is their call.

---

## Never restart the service yourself

The chat app you're reading this through *is* this service — `systemctl
restart xqlytskg-chat`, killing/exiting the node process, or calling
`POST /api/restart` or `POST /api/deploy` all cut the connection the human
is talking to you over. Doing this on your own initiative drops them
mid-conversation with no warning.

**Always ask the human to restart it themselves** (or explicitly confirm
first) rather than running the restart/deploy step on your own. This
applies to every agent working in this repo, not just one instance.

---

## CodeGraph MCP

A local codebase graph server (tree-sitter + SQLite) exposed via MCP.
Config lives in `.mcp.json` at repo root — agents on any install pick it up automatically.

**Tools:**
- `codegraph_search(query, limit?)` — find symbols by name/signature
- `codegraph_file(file)` — all symbols in a file
- `codegraph_callers(symbolId)` — who calls this symbol
- `codegraph_callees(symbolId)` — what this symbol calls
- `codegraph_reindex()` — full re-index

**Workflow:** When exploring an unfamiliar codebase, start with `codegraph_search` to locate a symbol, then `codegraph_callers`/`codegraph_callees` to trace call chains, and `codegraph_file` to see a file's full structure. Replaces dozens of grep/read calls with single graph lookups.

**Limitations:** Edge resolution (calls/imports) is best-effort — cross-file calls may be missed. Verify critical paths with direct `Read` tool.
