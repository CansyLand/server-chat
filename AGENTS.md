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
