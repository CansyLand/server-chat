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

_When new app-specific features get added in the future, their usage docs
should be appended here — this file is the one place any agent running
behind this app should look, regardless of which install or account it's
running under._
