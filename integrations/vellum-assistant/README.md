# Cognee Plugin for Vellum Assistant

Cognee knowledge graph memory for Vellum Assistant. Session-aware storage, auto-routing recall, and persistent learning across sessions. Supports local mode (self-hosted Cognee server) and Cognee Cloud.

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
| `init` | Plugin load | Disables Vellum default memory (config.json + .disabled sentinels), resolves backend, mints API key if local, passes LLM key to managed server |
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

The plugin is installed at `$VELLUM_WORKSPACE_DIR/plugins/cognee/`. All state lives under `$VELLUM_WORKSPACE_DIR/.cognee-plugin/` (shared: API key cache, server-ready marker, circuit breaker) and `$VELLUM_WORKSPACE_DIR/.cognee-plugin/vellum-assistant/` (per-session: config, logs, session maps, bridge cache).

## Configuration

### Environment variables

See [`.env.example`](.env.example) for a full template with comments. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `COGNEE_BASE_URL` | `http://localhost:8011` | Cognee server URL |
| `COGNEE_API_KEY` | (none) | API key for the Cognee server (or injected from credential store) |
| `COGNEE_API_KEY_CREDENTIAL` | (none) | Credential reference in `service:field` form (e.g. `cognee:api_key`) |
| `LLM_API_KEY` | (none) | LLM key for the Cognee server's cognify pipeline (passed to managed server automatically) |
| `COGNEE_LLM_API_KEY_CREDENTIAL` | (none) | Credential reference for the LLM key (e.g. `openai:api_key`) |
| `COGNEE_PLUGIN_DATASET` | `agent_sessions` | Dataset name for storage |
| `COGNEE_AGENT_NAME` | `vellum-assistant` | Agent name for session IDs |
| `COGNEE_SESSION_PREFIX` | `vellum` | Session ID prefix |
| `COGNEE_BREAKER_THRESHOLD` | `5` | Failures before circuit opens |
| `COGNEE_BREAKER_COOLDOWN` | `120` | Seconds before retry after circuit opens |
| `COGNEE_MANAGED` | (auto) | `true` = plugin manages local server, `false` = external server |

### Config file

`$VELLUM_WORKSPACE_DIR/.cognee-plugin/vellum-assistant/config.json` — created on first init, can be edited manually:

```json
{
  "managed": true,
  "base_url": "http://127.0.0.1:8011",
  "api_key_credential": "",
  "llm_api_key_credential": "",
  "dataset": "agent_sessions",
  "agent_name": "vellum-assistant",
  "session_prefix": "vellum",
  "auto_improve_every": 30
}
```

### Credential store integration

The plugin supports Vellum's credential store for both the Cognee API key and the LLM API key. Set credential references in the plugin's `config.json`:

```json
{
  "managed": false,
  "base_url": "https://your-cognee-cloud-instance",
  "api_key_credential": "cognee:api_key",
  "llm_api_key_credential": "openai:api_key"
}
```

The Vellum host resolves each credential reference to an env var before the plugin hooks run:
- `api_key_credential` → `COGNEE_API_KEY` (authenticates the plugin to the Cognee server)
- `llm_api_key_credential` → `LLM_API_KEY` (used by the Cognee server for graph sync)

In managed mode, `LLM_API_KEY` is passed through to the spawned Cognee server process automatically. For local servers, `api_key_credential` can be left empty — the plugin auto-mints a key on first run.

## Quick start / reproduction

### Option A: Local managed server (default, zero-config)

No config needed — the plugin provisions a Python venv, installs cognee, and starts a uvicorn server automatically. The only thing you need to provide is an LLM API key for the Cognee server's graph sync pipeline.

```bash
# 1. Hatch a Vellum assistant (if you don't already have one running)
vellum hatch vellum --name my-assistant --remote docker --gateway-port 7830 -d

# 2. Install the plugin into the assistant's workspace
vellum exec my-assistant -- assistant plugins install https://github.com/vellum-ai/cognee-integrations/tree/main/integrations/vellum-assistant

# 3. Set the LLM API key for the Cognee server (needed for graph sync).
#    The plugin passes this through to the managed server automatically.
#    Either export it in the assistant's env, or use the credential store:
vellum exec my-assistant -- bash -c 'cat > /workspace/.cognee-plugin/vellum-assistant/config.json << EOF
{
  "managed": true,
  "llm_api_key_credential": "openai:api_key"
}
EOF'

# 4. Start a conversation to trigger the init hook.
#    The init hook will:
#      - Create a Python venv at $VELLUM_WORKSPACE_DIR/.cognee-plugin/server-venv
#      - Install cognee into it (Python 3.10+ required on the host)
#      - Start uvicorn on 127.0.0.1:8011 with LLM_API_KEY in its env
#      - Mint a Cognee API key and cache it
#      - Disable Vellum's default memory
vellum exec my-assistant -- vellum message "hello"
```

### Option B: External / Cognee Cloud server

```bash
# 1. Hatch a Vellum assistant
vellum hatch vellum --name my-assistant --remote docker --gateway-port 7830 -d

# 2. Install the plugin
vellum exec my-assistant -- assistant plugins install https://github.com/vellum-ai/cognee-integrations/tree/main/integrations/vellum-assistant

# 3. Create a config file pointing to your external server
vellum exec my-assistant -- bash -c 'mkdir -p /workspace/.cognee-plugin/vellum-assistant && cat > /workspace/.cognee-plugin/vellum-assistant/config.json << EOF
{
  "managed": false,
  "base_url": "https://your-cognee-server-url",
  "api_key_credential": "cognee:api_key",
  "llm_api_key_credential": "openai:api_key"
}
EOF'

# 4. Start a conversation to trigger init
vellum exec my-assistant -- vellum message "hello"
```

### Verifying the plugin is working

```bash
# Server health (inside the assistant container)
vellum exec my-assistant -- curl http://localhost:8011/health

# Plugin hook log (JSON lines — one per hook invocation)
vellum exec my-assistant -- cat /workspace/.cognee-plugin/vellum-assistant/hook.log

# API key cache (local mode auto-mints one)
vellum exec my-assistant -- cat /workspace/.cognee-plugin/api_key.json

# Server log (managed mode)
vellum exec my-assistant -- cat /workspace/.cognee-plugin/vellum-assistant/server.log

# Assistant daemon logs
vellum exec my-assistant -- cat /workspace/data/logs/assistant-$(date +%Y-%m-%d).log | grep cognee
```

## Cognee server

If using local mode, the Cognee server must be running at the configured `COGNEE_BASE_URL` (default `http://localhost:8011`). The plugin does not start the server itself — it expects one to already be running, either:

- A local Cognee server (`cognee serve` or the Cognee Docker image)
- A Cognee Cloud instance (set `COGNEE_BASE_URL` to your cloud URL)

If the server is unreachable, all hooks degrade gracefully (no-ops) and the circuit breaker prevents hammering.

### LLM API key (required for graph sync)

The `/api/v1/remember` endpoint (used for session-to-graph sync) runs Cognee's cognify pipeline, which requires an LLM API key on the server. Without it, graph sync will fail with `LLMAPIKeyNotSetError`.

Session memory (`/api/v1/remember/entry` for QA pairs and traces) does **not** require an LLM key and works without one.

**In managed mode**: the plugin passes `LLM_API_KEY` to the spawned server process automatically. Set it via `llm_api_key_credential` in config or the `LLM_API_KEY` env var.

**In remote mode**: configure the LLM key on the Cognee server itself:

```bash
# Via the settings API
curl -X POST http://localhost:8011/api/v1/settings \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <key>" \
  -d '{"llm_api_key":"sk-..."}'

# Or via environment variable on the server process
export LLM_API_KEY=sk-...
```

The init hook checks for an LLM key and logs a warning if none is configured.

## API key resolution

1. `COGNEE_API_KEY` env var (highest priority, also used for credential store injection)
2. Cached key at `$VELLUM_WORKSPACE_DIR/.cognee-plugin/api_key.json` (minted on first init for local servers)
3. For local servers with no key: the init hook mints one via `/api/v1/auth/login` + `/api/v1/auth/api-keys`

When `api_key_credential` is set in config (e.g. `cognee:api_key`), the Vellum host resolves the credential and injects it as `COGNEE_API_KEY` before hooks run, so it flows through path 1 above.

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
