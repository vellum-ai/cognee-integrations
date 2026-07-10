# Cognee Plugin for Vellum Assistant

Cognee knowledge graph memory for Vellum Assistant. Session-aware storage, auto-routing recall, and persistent learning across sessions. Supports local mode (self-hosted Cognee server) and Cognee Cloud.

## Quick start

### Option A: Local mode (default, zero-config server)

The plugin provisions a Python venv, installs cognee, and starts a uvicorn server automatically. The only thing you need to provide is an LLM API key for the Cognee server's graph sync pipeline.

```bash
# 1. Hatch a Vellum assistant
vellum hatch --name my-assistant --remote docker -d

# 2. Store the LLM API key the Cognee server will use for graph sync
vellum exec my-assistant -- assistant credentials set sk-... --service cognee --field llm_api_key

# 3. Install the plugin (triggers the init hook, which provisions and starts the server)
vellum exec my-assistant -- assistant plugins install cognee

# 4. Start a conversation
vellum message my-assistant "hello"
```

### Option B: External / Cognee Cloud server

```bash
# 1. Hatch a Vellum assistant
vellum hatch --name my-assistant --remote docker -d

# 2. Store the Cognee API key and LLM API key
vellum exec my-assistant -- assistant credentials set your-cognee-api-key --service cognee --field api_key
vellum exec my-assistant -- assistant credentials set sk-... --service cognee --field llm_api_key

# 3. Install the plugin
vellum exec my-assistant -- assistant plugins install cognee

# 4. Configure the plugin to point at the external server
vellum exec my-assistant -- bash -c 'cat > /workspace/plugins/cognee/config.json << EOF
{
  "mode": "cloud",
  "base_url": "https://your-cognee-server-url"
}
EOF'

# 5. Start a conversation
vellum message my-assistant "hello"
```

## Architecture

This is a **pure TypeScript** plugin — no Python, no subprocess. All logic runs in-process under Bun, using Bun's native `fetch` for HTTP calls to the Cognee API.

### File layout

```
vellum-assistant/
  package.json              # Vellum plugin manifest (peer dep @vellumai/plugin-api ^0.10.3)
  src/
    cognee-client.ts         # HTTP client: recall, remember, agent registration, circuit breaker
    plugin-common.ts         # Config, session mapping, logging, bridge cache, API key resolution
    bridge.ts                # Session resolution helpers (conversationId → Cognee session)
    session-start.ts         # Init logic: backend check, API key minting, agent registration
    session-context-lookup.ts # Recall for auto-context injection (session + trace + graph)
    store-to-session.ts      # Store tool calls (TraceEntry) and QA pairs (QAEntry)
    store-user-prompt.ts     # Stage user prompt for pairing with assistant response
    sync-session-to-graph.ts # Bridge session cache → permanent graph (dedup by hash)
    post-compact.ts          # Build memory anchor after context compaction
    exit-watcher.ts          # Background: final sync when parent process exits
    idle-watcher.ts          # Background: sync idle sessions
  hooks/
    init.ts                  # Plugin init: disable Vellum default memory, resolve backend
    user-prompt-submit.ts    # Auto-recall + stage prompt
    post-tool-use.ts         # Store tool calls as TraceEntries
    stop.ts                  # Pair prompt+response as QAEntry, auto-sync threshold
    post-compact.ts          # Inject memory anchor after compaction
    shutdown.ts              # Final graph sync + unregister agent
  tools/
    cognee-recall.ts         # Model-visible tool for explicit memory search
  skills/
    cognee-remember/         # Skill: store data in permanent graph
    cognee-search/           # Skill: search memory (uses cognee_recall tool)
    cognee-sync/             # Skill: manual session-to-graph sync
```

### Hook mapping

| Hook | Fires | What it does |
|------|-------|-------------|
| `init` | Plugin install/load | Disables Vellum default memory, resolves backend, mints API key if local, passes LLM key to local server |
| `user-prompt-submit` | Each user turn | Auto-recalls relevant context from Cognee, injects into messages, stages prompt |
| `post-tool-use` | After each tool call | Stores tool call as TraceEntry in session cache |
| `stop` | Turn end | Pairs staged prompt with assistant response as QAEntry, triggers graph sync if threshold reached |
| `post-compact` | After compaction | Pulls memory anchor (recent QAs, trace, graph context), injects into compacted history |
| `shutdown` | Plugin unload | Final graph sync, unregisters agent connection |

### Disabling Vellum's default memory

The `init` hook disables Vellum's built-in memory system so Cognee is the sole memory provider:

1. **Config flags**: Writes `memory.enabled = false` and `memory.v2.enabled = false` to `<workspace>/config.json`. The daemon's config cache auto-invalidates on file change.

2. **Default plugin sentinels**: Creates `.disabled` sentinel files at:
   - `<workspace>/plugins/default-memory-retrieval/.disabled`
   - `<workspace>/plugins/default-memory-v3-shadow/.disabled`

This works because user plugin `init` hooks run **before** `bootstrapPlugins()` checks the `.disabled` sentinels for default plugins.

### Circuit breaker

Recall calls go through a file-based circuit breaker (`$VELLUM_WORKSPACE_DIR/.cognee-plugin/recall-breaker.json`). After 5 consecutive failures (UNREACHABLE or 5xx), the breaker opens for 120 seconds. A reachable 4xx (auth error) does NOT trip the breaker — waiting won't fix a config problem.

### Session management

The host session key (Vellum `conversationId`) maps to a deterministic Cognee session ID via first-writer-wins file creation at `$VELLUM_WORKSPACE_DIR/.cognee-plugin/vellum-assistant/sessions/<hostKey>.json`. A separate per-launch `conn_uuid` is the registration/liveness handle.

### Plugin directory

The plugin is installed at `$VELLUM_WORKSPACE_DIR/plugins/cognee/`. All state lives under `$VELLUM_WORKSPACE_DIR/.cognee-plugin/` (shared: API key cache, server-ready marker, circuit breaker) and `$VELLUM_WORKSPACE_DIR/.cognee-plugin/vellum-assistant/` (per-session: logs, session maps, bridge cache).

## Configuration

### Config file

`$VELLUM_WORKSPACE_DIR/plugins/cognee/config.json` — standard plugin config location, read by the host on init:

```json
{
  "mode": "local",
  "base_url": "http://127.0.0.1:8011",
  "api_key_credential": "cognee:api_key",
  "llm_api_key_credential": "cognee:llm_api_key",
  "dataset": "agent_sessions",
  "agent_name": "vellum-assistant",
  "session_prefix": "vellum",
  "auto_improve_every": 30
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `local` | `local` = plugin manages server (venv + uvicorn), `cloud`/`server` = external |
| `base_url` | `http://127.0.0.1:8011` | Cognee server URL |
| `api_key_credential` | `cognee:api_key` | Credential reference `service:field` for the Cognee API key |
| `llm_api_key_credential` | `cognee:llm_api_key` | Credential reference `service:field` for the LLM key (graph sync) |
| `dataset` | `agent_sessions` | Dataset name for storage |
| `agent_name` | `vellum-assistant` | Agent name for session IDs |
| `session_prefix` | `vellum` | Session ID prefix |
| `auto_improve_every` | `30` | Save count before auto-sync to graph |

### Credential store integration

The plugin resolves credentials via `assistant credentials reveal --service <s> --field <f> --json` at runtime. Two credential references are supported:

- **`api_key_credential`** (e.g. `cognee:api_key`) — authenticates the plugin to the Cognee server. For local servers, can be left empty (auto-minted on first run).
- **`llm_api_key_credential`** (e.g. `openai:api_key`) — the LLM key the Cognee server needs for its cognify pipeline (graph sync). In local mode, the plugin passes this to the spawned server as `COGNEE_LLM_API_KEY`. For remote servers, configure the LLM key on the server itself.

## Cognee server

In local mode, the plugin manages the Cognee server lifecycle automatically — it provisions a Python venv, installs cognee, and starts a uvicorn server at the configured `base_url` (default `http://127.0.0.1:8011`). The init hook is triggered on plugin install.

In cloud/server mode, the Cognee server must already be running at the configured `base_url`. If the server is unreachable, all hooks degrade gracefully (no-ops) and the circuit breaker prevents hammering.

### LLM API key (required for graph sync)

The `/api/v1/remember` endpoint (used for session-to-graph sync) runs Cognee's cognify pipeline, which requires an LLM API key on the server. Without it, graph sync will fail with `LLMAPIKeyNotSetError`.

Session memory (`/api/v1/remember/entry` for QA pairs and traces) does **not** require an LLM key and works without one.

**In local mode**: the plugin resolves `llm_api_key_credential` via the credential store and passes it to the spawned server as `COGNEE_LLM_API_KEY`. Set it via `assistant credentials set --service cognee --field llm_api_key`.

**In cloud/server mode**: configure the LLM key on the Cognee server itself:

```bash
curl -X POST http://localhost:8011/api/v1/settings \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <key>" \
  -d '{"llm_api_key":"sk-..."}'
```

The init hook checks for an LLM key and logs a warning if none is configured.

## API key resolution

1. Credential store (via `assistant credentials reveal` if `api_key_credential` is set)
2. `COGNEE_API_KEY` env var (manual override)
3. Cached key at `$VELLUM_WORKSPACE_DIR/.cognee-plugin/api_key.json` (auto-minted on first init for local servers)
4. For local servers with no key: the init hook mints one via `/api/v1/auth/login` + `/api/v1/auth/api-keys`

## Diff from Claude Code integration

This integration is adapted from the [Claude Code cognee plugin](../claude-code/). Key differences:

| Aspect | Claude Code | Vellum Assistant |
|--------|-------------|-------------------|
| Language | Python scripts + shell wrappers | Pure TypeScript (Bun) |
| Hooks | JSON-configured subprocess hooks | TypeScript hooks (in-process) |
| Manifest | `.claude-plugin/plugin.json` + `hooks/hooks.json` | `package.json` |
| Tools | Agent definition (markdown) | `ToolDefinition` (TypeScript) |
| Memory disabling | N/A | Disables Vellum default memory via config + sentinels |
| Plugin dir | `~/.claude/plugins/` | `$VELLUM_WORKSPACE_DIR/plugins/cognee/` |
| Session key | Claude session ID | Vellum `conversationId` |
| Subprocess | Yes (Python via stdin/stdout JSON) | No (all in-process) |
