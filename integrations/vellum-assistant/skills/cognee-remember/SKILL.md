---
name: cognee-remember
description: Store data permanently in the Cognee knowledge graph. Accepts a data category (user, project, or agent) to tag the data with the correct node_set for filtered retrieval.
---

# Cognee Permanent Memory Storage

Store data permanently in the Cognee knowledge graph with category tagging.

## Data categories

Cognee organizes knowledge into three categories via `node_set` tagging:

| Category | Node set | What belongs here |
|----------|----------|-------------------|
| **user** | `user_context` | User preferences, corrections, personal facts, communication style |
| **project** | `project_docs` | Repository docs, code context, architecture decisions, company data |
| **agent** | `agent_actions` | Tool call logs, reasoning traces, generated artifacts (auto-captured by hooks) |

## Instructions

Determine the category from the user's intent, then run:

**User data** (preferences, corrections, personal context):
```bash
${VELLUM_PLUGIN_ROOT}/scripts/cognee-remember.sh "$ARGUMENTS" --node-set user_context
```

**Project data** (docs, code, company knowledge):
```bash
${VELLUM_PLUGIN_ROOT}/scripts/cognee-remember.sh "$ARGUMENTS" --node-set project_docs
```

**Agent data** (explicit agent notes — routine tool logs are automatic):
```bash
${VELLUM_PLUGIN_ROOT}/scripts/cognee-remember.sh "$ARGUMENTS" --node-set agent_actions
```

The wrapper POSTs to the running Cognee server (`/api/v1/remember`). A `{"ok": true}` response means the server accepted the data. An error response means the server rejected or failed the request — check `COGNEE_API_KEY` and server logs; do **not** re-run or conclude the data wasn't stored without confirming against the server.

**IMPORTANT**: The wrapper always runs in the foreground (`run_in_background=false`) to ensure the full pipeline completes before returning.

## Fallback only — server unreachable

`cognee-cli` is a thin client over the same server. Use it only when the server is genuinely down:

```bash
cognee-cli remember "$ARGUMENTS" -d "${COGNEE_PLUGIN_DATASET:-agent_sessions}" --node-set user_context
```

**Empty or clean CLI output does NOT confirm the data was stored.** Verify via the server directly once it is back up.

## When to use

- User says "remember this" or "save this" -> category **user**
- User says "remember this about the project/codebase" -> category **project**
- You want to persist your own findings or conclusions -> category **agent**
- NOT for routine tool call logging (that's automatic via hooks with `agent_actions` tagging)

## Category routing guide

| Signal | Category |
|--------|----------|
| "remember my preference for..." | user |
| "I always want..." / "I prefer..." | user |
| "remember this about the codebase" | project |
| "save these docs" / "index this file" | project |
| "note that this API works like..." | project |
| "remember what we discovered" | agent |
| Routine tool calls | agent (automatic, no action needed) |
