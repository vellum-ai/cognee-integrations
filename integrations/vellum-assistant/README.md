# Cognee Memory Plugin for Vellum Assistant

Adds persistent memory to Vellum Assistant through Cognee.

The integration:
- captures prompts, tool traces, and assistant responses into session memory
- injects relevant context on prompt submit
- syncs session memory into graph memory on session end/final exit

## Structure

This is a Vellum Assistant plugin that bundles three surfaces:

| Surface | Directory | What it does |
|---------|-----------|-------------|
| Lifecycle hooks | `hooks/` | TypeScript hooks that run at fixed points in the agent loop |
| Model-visible tool | `tools/` | `cognee_recall` tool for on-demand memory search |
| Skills | `skills/` | On-demand instruction bundles for remember, search, and sync |

The hooks are thin TypeScript wrappers that spawn the Python helper scripts in `scripts/`. The Python scripts handle all Cognee API interaction, session management, circuit breaking, and venv bootstrapping — they are kept as-is from the Claude Code integration and adapted for Vellum's config paths and naming conventions.

## Install

Copy this directory into your Vellum workspace's `plugins/` folder:

```
cp -R vellum-assistant $VELLUM_WORKSPACE_DIR/plugins/cognee-memory
```

Then set environment variables for your runtime mode.

**Cognee Cloud or a remote server** — set both:

```bash
export COGNEE_BASE_URL="https://your-instance.cognee.ai"
export COGNEE_API_KEY="ck_..."
```

**Local mode** (default when `COGNEE_BASE_URL` is not set) — the plugin bootstraps a local Cognee API at `http://localhost:8011`. Only `LLM_API_KEY` is required; `COGNEE_API_KEY` is auto-minted if absent:

```bash
export LLM_API_KEY="sk-..."
```

You can also set config in `~/.cognee-plugin/vellum-assistant/config.json`:

```json
{
  "base_url": "https://your-instance.cognee.ai",
  "dataset": "agent_sessions"
}
```

## Hooks

| Vellum Hook | Replaces Claude Code Hook | Behavior |
|-------------|--------------------------|---------|
| `init` | `SessionStart` | mode select, identity setup, dataset readiness, watcher bootstrap |
| `user-prompt-submit` | `UserPromptSubmit` | dataset-scoped context lookup + async prompt staging |
| `post-tool-use` | `PostToolUse` | async trace write |
| `stop` | `Stop` | assistant answer write |
| `post-compact` | `PreCompact` | memory anchor build after compaction |
| `shutdown` | `SessionEnd` | trigger detached final sync worker |

## Tool

| Tool | Description |
|------|-------------|
| `cognee_recall` | Searches Cognee memory (session cache and permanent knowledge graph). The model can call this for deeper or cross-session searches. |

## Skills

- `cognee-remember` — Store data permanently in the Cognee knowledge graph with category tagging
- `cognee-search` — Search session memory and the permanent knowledge graph
- `cognee-sync` — Sync session cache entries into the permanent knowledge graph

## Auth

The integration uses a **single auth principal** — one API key, one user.

Key resolution order:
1. `COGNEE_API_KEY` env var
2. `~/.cognee-plugin/api_key.json` (cached from a previous mint)
3. Auto-mint from the default local user (local mode only), then cache to `api_key.json`

## Mode selection rules

At startup (`init`):
- `COGNEE_BASE_URL` set -> `managed_endpoint`, either local, or on Cognee Cloud (API key needed in cloud case)
- otherwise -> `integration_local` (local API bootstrap)

At hook runtime:
- hooks resolve mode through runtime endpoint auth (env + `api_key.json`), not only config intent
- `http` mode skips local SDK initialization

## Sessions

Each conversation maintains a small map file:

```
~/.cognee-plugin/vellum-assistant/session-map.json
  → { "<conversationId>": "<cognee_session_id>", ... }
```

The Vellum `conversationId` is used as the local correlation key. A Cognee session id is generated as `vellum_<conversationId>` by default.

Set `COGNEE_SESSION_ID` to resume a specific session:

```bash
export COGNEE_SESSION_ID="my-project"
```

## Dataset

All writes and recall are scoped to a single dataset. By default the plugin uses `agent_sessions`, so memory is shared across integrations automatically.

Set a custom dataset at launch:

```bash
export COGNEE_PLUGIN_DATASET="my-project-memory"
```

Or persist it in `~/.cognee-plugin/vellum-assistant/config.json`:

```json
{ "dataset": "my-project-memory" }
```

## Memory preference

With the plugin active, Cognee is the **preferred** memory system: relevant memory is auto-recalled into context on every `user-prompt-submit` and writes are captured automatically. The `init` hook injects an `additionalContext` instruction telling the assistant to treat Cognee as authoritative.

| Env var | Default | Effect |
|---|---|---|
| `COGNEE_PREFER_MEMORY` | `true` | Inject init steer asserting Cognee as the preferred memory |

## Session sync and watchers

An idle watcher runs in the background for the lifetime of each launch. It polls activity every `COGNEE_IDLE_POLL` seconds and persists the session cache when the session has been quiet for `COGNEE_IDLE_THRESHOLD` seconds, then waits at least `COGNEE_IMPROVE_COOLDOWN` seconds before the next run.

| Env var | Default | Effect |
|---|---|---|
| `COGNEE_IDLE_POLL` | `10` | Poll interval in seconds |
| `COGNEE_IDLE_THRESHOLD` | `60` | Seconds of inactivity before idle sync fires |
| `COGNEE_IMPROVE_COOLDOWN` | `120` | Minimum seconds between idle sync runs |

Final sync on session end is triggered by the `shutdown` hook's detached worker, with an exit watcher as fallback if the process exits without firing `shutdown`.

## Remember (write) behavior

`cognee-remember` and the auto-capture hooks POST to the server's `/api/v1/remember` and ask it to build the graph **in the background** (`run_in_background=true`), so the write returns as soon as it's enqueued.

| Env var | Default | Effect |
|---|---|---|
| `COGNEE_REMEMBER_BACKGROUND` | `true` | Build the graph in the background; set `false` for a synchronous, immediately-queryable write |

## Logs and state

Vellum Assistant-specific plugin state and logs are written under:

```bash
~/.cognee-plugin/vellum-assistant/
```

Useful logs:

```bash
tail -f ~/.cognee-plugin/vellum-assistant/hook.log
tail -f ~/.cognee-plugin/vellum-assistant/subprocess.log
tail -f ~/.cognee-plugin/vellum-assistant/watcher.log
tail -f ~/.cognee-plugin/vellum-assistant/exit-watcher.log
tail -f ~/.cognee-plugin/vellum-assistant/recall-audit.log
```

Shared state (used by all Cognee plugin integrations):

```bash
~/.cognee-plugin/api_key.json     # cached API key
~/.cognee-plugin/venv/            # shared Cognee virtualenv
```

## Configuration reference

Config precedence:
1. env vars
2. `~/.cognee-plugin/vellum-assistant/config.json`
3. defaults

| Key | Env var(s) | Default | Notes |
|---|---|---|---|
| `dataset` | `COGNEE_PLUGIN_DATASET` | `agent_sessions` | Dataset for writes and recall |
| `session_id` | `COGNEE_SESSION_ID` | auto-generated per conversation | Override to resume a named session |
| `session_strategy` | `COGNEE_SESSION_STRATEGY` | `per-directory` | `per-directory`, `git-branch`, `static` |
| `session_prefix` | `COGNEE_SESSION_PREFIX` | `vellum` | Prefix for auto-generated session IDs |
| `base_url` | `COGNEE_BASE_URL` | unset | Set to enable managed endpoint mode |
| `api_key` | `COGNEE_API_KEY` | unset | API key; auto-minted if absent in local mode |
| local URL override | `COGNEE_LOCAL_API_URL` | `http://localhost:8011` | Local API base URL |
| local LLM | `LLM_API_KEY`, `LLM_MODEL` | unset | Required for local mode runtime |
| idle watcher poll | `COGNEE_IDLE_POLL` | `10` | Idle watcher poll interval in seconds |
| idle watcher threshold | `COGNEE_IDLE_THRESHOLD` | `60` | Seconds of inactivity before idle sync fires |
| idle watcher cooldown | `COGNEE_IMPROVE_COOLDOWN` | `120` | Minimum seconds between idle sync runs |

## Differences from the Claude Code integration

- **Hooks**: TypeScript hooks running in-process (Vellum plugin model) instead of JSON-configured subprocess commands (Claude Code plugin model). The hooks spawn the same Python scripts via `Bun.spawn`.
- **Agent → Tool**: The Claude Code `agents/cognee-recall.md` agent definition is replaced by a `tools/cognee-recall.ts` model-visible tool.
- **Status line**: Claude Code's status line mechanism does not exist in Vellum. The status line scripts are kept for reference but not wired.
- **Clear transcript**: The `clear-transcript-context.py` hook is Claude Code specific. It is retained but not wired into any Vellum hook.
- **Config paths**: State lives under `~/.cognee-plugin/vellum-assistant/` instead of `~/.cognee-plugin/claude-code/`.
- **Session correlation**: Uses Vellum's `conversationId` instead of Claude Code's `session_id` payload field.
- **Compaction**: Vellum fires `post-compact` (after compaction) rather than Claude Code's `PreCompact` (before). The memory anchor is injected into the compacted history.

## Troubleshooting

**Recall returns empty but data was ingested**
- Recall is scoped to the active dataset (`COGNEE_PLUGIN_DATASET` / `config.json` / `agent_sessions`).
- To verify, call the recall API directly: `curl -X POST "$COGNEE_BASE_URL/api/v1/recall" -d '{"query":"..."}'`

**Session not resolving / wrong session shown**
- Check `~/.cognee-plugin/vellum-assistant/session-map.json` — this is the map file for your conversation.
- If it's missing, the `init` hook may not have completed; check `~/.cognee-plugin/vellum-assistant/hook.log`.

**Unauthorized / key errors**
- Check `~/.cognee-plugin/api_key.json`. Delete it to force a re-mint.

**Final sync diagnostics**
- Check `~/.cognee-plugin/vellum-assistant/hook.log` and `~/.cognee-plugin/vellum-assistant/exit-watcher.log`.
