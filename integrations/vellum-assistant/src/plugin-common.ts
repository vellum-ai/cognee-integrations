/**
 * Shared helpers across all plugin modules.
 *
 * Ported from _plugin_common.py and config.py. Provides:
 *   - Config loading (file + env vars + defaults)
 *   - Session ID resolution and mapping
 *   - Hook logging to disk
 *   - File-based state management
 *   - API key resolution and caching
 *   - Plugin directory resolution
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// ─── Plugin directory resolution ──────────────────────────────────────────────

/**
 * The plugin's root directory. At runtime this is set by the bridge from
 * VELLUM_PLUGIN_ROOT or derived from the module URL. In Vellum's plugin
 * layout, plugins live at $VELLUM_WORKSPACE_DIR/plugins/<name>.
 */
let pluginRoot = process.env.VELLUM_PLUGIN_ROOT ?? "";

export function setPluginRoot(root: string): void {
  pluginRoot = root;
}

export function getPluginRoot(): string {
  if (pluginRoot) return pluginRoot;
  // Derive from this module's URL.
  try {
    const url = import.meta.url;
    const path = url.replace(/^file:\/\//, "");
    pluginRoot = join(dirname(path), "..");
  } catch {
    pluginRoot = process.cwd();
  }
  return pluginRoot;
}

/**
 * Shared state directory (~/.cognee-plugin) for cross-session state like
 * the API key cache, server-ready marker, and circuit breaker.
 */
export function sharedStateDir(): string {
  return process.env.COGNEE_PLUGIN_STATE_DIR ?? join(homedir(), ".cognee-plugin");
}

/**
 * Per-plugin state directory for vellum-assistant specifically.
 */
export function pluginStateDir(): string {
  return join(sharedStateDir(), "vellum-assistant");
}

/**
 * The workspace directory, derived from VELLUM_WORKSPACE_DIR or from the
 * plugin storage dir (up two levels from plugins-data/<name>).
 */
export function workspaceDir(): string {
  if (process.env.VELLUM_WORKSPACE_DIR) return process.env.VELLUM_WORKSPACE_DIR;
  // Fallback: pluginStorageDir is <workspace>/plugins-data/<plugin>, so up 2.
  if (process.env.VELLUM_PLUGIN_STORAGE_DIR) {
    return join(process.env.VELLUM_PLUGIN_STORAGE_DIR, "..", "..");
  }
  return "";
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface CogneePluginConfig {
  mode: "local" | "cloud" | "server";
  baseUrl: string;
  apiKey: string;
  dataset: string;
  agentName: string;
  sessionPrefix: string;
  autoImproveEvery: number;
}

const DEFAULT_CONFIG: CogneePluginConfig = {
  mode: "local",
  baseUrl: "http://localhost:8011",
  apiKey: "",
  dataset: "agent_sessions",
  agentName: "vellum-assistant",
  sessionPrefix: "vellum",
  autoImproveEvery: 30,
};

function configPath(): string {
  return join(pluginStateDir(), "config.json");
}

export function loadConfig(): CogneePluginConfig {
  const cfg = { ...DEFAULT_CONFIG };

  // 1. Config file
  try {
    const data = JSON.parse(readFileSync(configPath(), "utf-8"));
    if (typeof data === "object" && data !== null) {
      if (data.base_url) cfg.baseUrl = String(data.base_url);
      if (data.api_key) cfg.apiKey = String(data.api_key);
      if (data.dataset) cfg.dataset = String(data.dataset);
      if (data.agent_name) cfg.agentName = String(data.agent_name);
      if (data.session_prefix) cfg.sessionPrefix = String(data.session_prefix);
      if (data.auto_improve_every) cfg.autoImproveEvery = Number(data.auto_improve_every);
      if (data.mode) cfg.mode = String(data.mode);
    }
  } catch {
    // No config file yet — write defaults so it exists for future reads.
    try {
      mkdirSync(pluginStateDir(), { recursive: true });
      writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    } catch {
      // Best-effort — don't fail if the dir isn't writable.
    }
  }

  // 2. Env var overrides (higher priority)
  if (process.env.COGNEE_BASE_URL) cfg.baseUrl = process.env.COGNEE_BASE_URL;
  if (process.env.COGNEE_LOCAL_API_URL && !process.env.COGNEE_BASE_URL) {
    cfg.baseUrl = process.env.COGNEE_LOCAL_API_URL;
  }
  if (process.env.COGNEE_API_KEY) cfg.apiKey = process.env.COGNEE_API_KEY;
  if (process.env.COGNEE_PLUGIN_DATASET) cfg.dataset = process.env.COGNEE_PLUGIN_DATASET;
  if (process.env.COGNEE_AGENT_NAME) cfg.agentName = process.env.COGNEE_AGENT_NAME;
  if (process.env.COGNEE_SESSION_PREFIX) cfg.sessionPrefix = process.env.COGNEE_SESSION_PREFIX;

  return cfg;
}

export function saveConfig(cfg: Partial<CogneePluginConfig>): void {
  try {
    const dir = pluginStateDir();
    mkdirSync(dir, { recursive: true });
    const existing = loadConfig();
    const merged = { ...existing, ...cfg };
    writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // Best-effort.
  }
}

/**
 * Determine if a URL is a loopback/local address.
 */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const hostname = u.hostname;
    return ["localhost", "127.0.0.1", "::1", ""].includes(hostname);
  } catch {
    return true;
  }
}

/**
 * Determine the active mode from the base URL.
 */
export function resolveMode(baseUrl: string): "local" | "cloud" {
  return isLocalUrl(baseUrl) ? "local" : "cloud";
}

// ─── Session key management ───────────────────────────────────────────────────

/**
 * Sanitize a string for use as a session key (alphanumeric + -_. only).
 */
export function sanitizeSessionKey(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9\-_.]/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 120);
}

/**
 * Get the session key from the env var (set by hooks from ctx.conversationId).
 */
export function getSessionKey(): string {
  const raw = process.env.COGNEE_SESSION_KEY ?? "";
  return sanitizeSessionKey(raw.trim());
}

/**
 * Build the Cognee session ID from the agent name and host session key.
 * Format: {agentName}_{hostSessionKey}
 */
export function buildSessionId(agentName: string, hostKey: string): string {
  return `${agentName}_${hostKey}`;
}

// ─── Session map (host key → Cognee session) ──────────────────────────────────

function sessionsDir(): string {
  return join(pluginStateDir(), "sessions");
}

function sessionMapPath(hostKey: string): string {
  return join(sessionsDir(), `${hostKey}.json`);
}

interface SessionMapRecord {
  session_id: string;
  conn_uuid: string;
  host_key: string;
  created_at: number;
}

/**
 * Resolve or create the Cognee session ID for a given host session key.
 * Uses first-writer-wins (O_CREAT|O_EXCL equivalent) so concurrent hooks
 * all resolve the same session.
 */
export function resolveSessionId(hostKey: string, agentName: string): string {
  const sanitized = sanitizeSessionKey(hostKey);
  if (!sanitized) return "";

  try {
    mkdirSync(sessionsDir(), { recursive: true });
    const path = sessionMapPath(sanitized);

    // Try to read existing.
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, "utf-8")) as SessionMapRecord;
      if (record.session_id) return record.session_id;
    }

    // First writer — create the record.
    const sessionId = buildSessionId(agentName, sanitized);
    const record: SessionMapRecord = {
      session_id: sessionId,
      conn_uuid: randomUUID(),
      host_key: sanitized,
      created_at: Date.now(),
    };
    writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
    return sessionId;
  } catch {
    return buildSessionId(agentName, sanitized);
  }
}

/**
 * Get the connection UUID for a given host session key.
 */
export function getConnUuid(hostKey: string): string {
  const sanitized = sanitizeSessionKey(hostKey);
  try {
    const path = sessionMapPath(sanitized);
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, "utf-8")) as SessionMapRecord;
      return record.conn_uuid ?? "";
    }
  } catch {
    // Fall through.
  }
  return "";
}

// ─── API key resolution ───────────────────────────────────────────────────────

function apiKeyCachePath(): string {
  return join(sharedStateDir(), "api_key.json");
}

interface ApiKeyCache {
  api_key: string;
  base_url: string;
  created_at: number;
}

/**
 * Load the cached API key (single-principal model).
 */
export function loadCachedApiKey(baseUrl: string): string {
  try {
    const cache = JSON.parse(readFileSync(apiKeyCachePath(), "utf-8")) as ApiKeyCache;
    if (cache.api_key) {
      // If the cached URL matches (or no URL in cache), use the key.
      if (!cache.base_url || cache.base_url.replace(/\/+$/, "") === baseUrl.replace(/\/+$/, "")) {
        return cache.api_key;
      }
    }
  } catch {
    // No cache yet.
  }
  return "";
}

/**
 * Cache the API key for future use.
 */
export function cacheApiKey(apiKey: string, baseUrl: string): void {
  try {
    const dir = sharedStateDir();
    mkdirSync(dir, { recursive: true });
    const cache: ApiKeyCache = {
      api_key: apiKey,
      base_url: baseUrl.replace(/\/+$/, ""),
      created_at: Date.now(),
    };
    writeFileSync(apiKeyCachePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Best-effort.
  }
}

/**
 * Resolve the API key for HTTP calls.
 * Priority: 1. env var, 2. cached key.
 */
export function resolveApiKey(baseUrl: string): string {
  const envKey = (process.env.COGNEE_API_KEY ?? "").trim();
  if (envKey) return envKey;
  return loadCachedApiKey(baseUrl);
}

/**
 * Resolve the HTTP endpoint (baseUrl + apiKey) for runtime calls.
 */
export function resolveHttpEndpoint(): { baseUrl: string; apiKey: string } {
  const cfg = loadConfig();
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  const apiKey = resolveApiKey(baseUrl);
  return { baseUrl, apiKey };
}

// ─── Hook logging ─────────────────────────────────────────────────────────────

const LOG_LINE_CAP = 600;

export function hookLog(event: string, detail?: Record<string, unknown>): void {
  try {
    const dir = pluginStateDir();
    mkdirSync(dir, { recursive: true });
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
    };
    if (detail) {
      // Cap detail values to avoid log bloat.
      const capped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(detail)) {
        capped[key] = typeof value === "string" ? value.slice(0, LOG_LINE_CAP) : value;
      }
      line.detail = capped;
    }
    writeFileSync(
      join(dir, "hook.log"),
      JSON.stringify(line) + "\n",
      { flag: "a", encoding: "utf-8" },
    );
  } catch {
    // Best-effort — never throw from logging.
  }
}

// ─── Activity tracking ────────────────────────────────────────────────────────

/**
 * Touch the activity file so the idle watcher knows we're alive.
 */
export function touchActivity(): void {
  try {
    const dir = pluginStateDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now() / 1000;
    writeFileSync(join(dir, "activity.ts"), String(now), "utf-8");
  } catch {
    // Best-effort.
  }
}

// ─── Save counter ─────────────────────────────────────────────────────────────

export const SAVE_KINDS = ["prompt", "trace", "answer"] as const;
type SaveKind = (typeof SAVE_KINDS)[number];

function saveCounterPath(): string {
  return join(pluginStateDir(), "save_counter.json");
}

interface SaveCounter {
  count: number;
  last_improve: number;
  kinds: Record<SaveKind, number>;
}

function readSaveCounter(): SaveCounter {
  try {
    return JSON.parse(readFileSync(saveCounterPath(), "utf-8"));
  } catch {
    return { count: 0, last_improve: 0, kinds: { prompt: 0, trace: 0, answer: 0 } };
  }
}

function writeSaveCounter(state: SaveCounter): void {
  try {
    mkdirSync(pluginStateDir(), { recursive: true });
    writeFileSync(saveCounterPath(), JSON.stringify(state), "utf-8");
  } catch {
    // Best-effort.
  }
}

/**
 * Bump the save counter and return whether it's time to auto-improve
 * (bridge session cache to graph).
 */
export function bumpSaveCounter(kind: SaveKind, threshold?: number): boolean {
  const cfg = loadConfig();
  const limit = threshold ?? cfg.autoImproveEvery;
  const state = readSaveCounter();
  state.count += 1;
  state.kinds[kind] = (state.kinds[kind] ?? 0) + 1;
  const shouldImprove = state.count - state.last_improve >= limit;
  if (shouldImprove) {
    state.last_improve = state.count;
  }
  writeSaveCounter(state);
  return shouldImprove;
}

// ─── Pending prompts (for pairing on Stop) ────────────────────────────────────

function pendingDir(): string {
  return join(pluginStateDir(), "pending");
}

function pendingPromptPath(sessionKey: string): string {
  return join(pendingDir(), `${sessionKey}.prompt.json`);
}

export interface PendingPrompt {
  prompt: string;
  timestamp: number;
  cwd: string;
}

export function stagePendingPrompt(sessionKey: string, prompt: string, cwd: string): void {
  try {
    mkdirSync(pendingDir(), { recursive: true });
    const entry: PendingPrompt = { prompt, timestamp: Date.now(), cwd };
    writeFileSync(pendingPromptPath(sessionKey), JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort.
  }
}

export function consumePendingPrompt(sessionKey: string): PendingPrompt | null {
  try {
    const path = pendingPromptPath(sessionKey);
    if (!existsSync(path)) return null;
    const entry = JSON.parse(readFileSync(path, "utf-8")) as PendingPrompt;
    // Delete after reading.
    try {
      writeFileSync(path, "", "utf-8");
    } catch {
      // Best-effort.
    }
    return entry;
  } catch {
    return null;
  }
}

// ─── Bridge cache (session cache shadow for HTTP-mode graph sync) ─────────────

function bridgeDir(): string {
  return join(pluginStateDir(), "bridge");
}

function bridgeFilePath(sessionId: string): string {
  return join(bridgeDir(), `${sessionId}.json`);
}

interface BridgeCache {
  [key: string]: {
    qa?: Array<{ question: string; answer: string }>;
    trace?: string[];
  };
  _state?: Record<string, string>;
}

function bridgeCacheKey(dataset: string, sessionId: string): string {
  return `${dataset}:${sessionId}`;
}

function loadBridgeFile(sessionId: string): BridgeCache {
  try {
    return JSON.parse(readFileSync(bridgeFilePath(sessionId), "utf-8"));
  } catch {
    return {};
  }
}

function writeBridgeFile(sessionId: string, cache: BridgeCache): void {
  try {
    mkdirSync(bridgeDir(), { recursive: true });
    writeFileSync(bridgeFilePath(sessionId), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Best-effort.
  }
}

/**
 * Record a QA entry in the bridge cache.
 */
export function recordBridgeQA(
  sessionId: string,
  dataset: string,
  question: string,
  answer: string,
): void {
  const cache = loadBridgeFile(sessionId);
  const key = bridgeCacheKey(dataset, sessionId);
  if (!cache[key]) cache[key] = {};
  if (!cache[key].qa) cache[key].qa = [];
  cache[key].qa!.push({ question, answer });
  writeBridgeFile(sessionId, cache);
}

/**
 * Record a trace entry in the bridge cache.
 */
export function recordBridgeTrace(
  sessionId: string,
  dataset: string,
  traceText: string,
): void {
  const cache = loadBridgeFile(sessionId);
  const key = bridgeCacheKey(dataset, sessionId);
  if (!cache[key]) cache[key] = {};
  if (!cache[key].trace) cache[key].trace = [];
  cache[key].trace!.push(traceText);
  writeBridgeFile(sessionId, cache);
}

/**
 * Format the cached bridge document for posting to the graph.
 * Returns [qaDoc, traceDoc] as text.
 */
export function formatBridgeDocument(
  sessionId: string,
  dataset: string,
): [string, string] {
  const cache = loadBridgeFile(sessionId);
  const key = bridgeCacheKey(dataset, sessionId);
  const sessionCache = cache[key] ?? {};

  const qaLines: string[] = [];
  for (const entry of sessionCache.qa ?? []) {
    if (entry.question) qaLines.push(`Question: ${entry.question}`);
    if (entry.answer) qaLines.push(`Answer: ${entry.answer}`);
    if (entry.question || entry.answer) qaLines.push("");
  }

  const traceLines = (sessionCache.trace ?? []).filter((t) => t.trim());

  let qaDoc = qaLines.join("\n").trim();
  let traceDoc = traceLines.join("\n\n").trim();
  if (qaDoc) qaDoc = `Session ID: ${sessionId}\n\n${qaDoc}`;
  if (traceDoc) traceDoc = `Session ID: ${sessionId}\n\n${traceDoc}`;
  return [qaDoc, traceDoc];
}

/**
 * Mark a bridge document as posted to the graph (dedup by content hash).
 */
export function markBridgePosted(
  sessionId: string,
  dataset: string,
  kind: string,
  document: string,
): void {
  const cache = loadBridgeFile(sessionId);
  if (!cache._state) cache._state = {};
  const stateKey = `${bridgeCacheKey(dataset, sessionId)}:${kind}`;
  cache._state[stateKey] = createHash("sha256").update(document).digest("hex");
  writeBridgeFile(sessionId, cache);
}

/**
 * Check if a bridge document has already been posted (same content hash).
 */
export function isBridgePosted(
  sessionId: string,
  dataset: string,
  kind: string,
  document: string,
): boolean {
  const cache = loadBridgeFile(sessionId);
  if (!cache._state) return false;
  const stateKey = `${bridgeCacheKey(dataset, sessionId)}:${kind}`;
  const digest = createHash("sha256").update(document).digest("hex");
  return cache._state[stateKey] === digest;
}

// ─── Server-ready marker ──────────────────────────────────────────────────────

function serverReadyPath(): string {
  return join(sharedStateDir(), "server-ready.json");
}

export function markServerReady(): void {
  try {
    const dir = sharedStateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      serverReadyPath(),
      JSON.stringify({ ready: true, ts: Date.now() }),
      "utf-8",
    );
  } catch {
    // Best-effort.
  }
}

export function clearServerReady(): void {
  try {
    const path = serverReadyPath();
    if (existsSync(path)) {
      writeFileSync(path, "", "utf-8");
    }
  } catch {
    // Best-effort.
  }
}

export function isServerReady(): boolean {
  try {
    const data = JSON.parse(readFileSync(serverReadyPath(), "utf-8"));
    if (!data.ready) return false;
    // TTL of 30 seconds.
    const age = Date.now() - (data.ts ?? 0);
    return age < 30_000;
  } catch {
    return false;
  }
}

// ─── Git branch detection (for session IDs) ───────────────────────────────────

import { spawn } from "bun";

export async function detectGitBranch(cwd: string): Promise<string> {
  try {
    const proc = spawn({
      cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return stdout.trim().replace(/[/\s]/g, "-").slice(0, 40);
    }
  } catch {
    // Not a git repo or git not available.
  }
  return "";
}

// ─── Memory preference (system message injection) ────────────────────────────

/**
 * Build the memory preference steer text that gets injected into the system
 * message on session start. Tells the assistant to prefer Cognee memory.
 */
export function memoryPreferenceSteer(): string {
  return [
    "## Cognee Memory Active",
    "",
    "Long-term memory is powered by Cognee. The assistant's built-in memory",
    "system has been disabled in favor of Cognee's knowledge graph.",
    "",
    "- Relevant context from prior sessions is automatically injected before each response.",
    "- Use the cognee_recall tool for deeper or cross-session searches.",
    "- Session interactions (prompts, tool calls, responses) are stored automatically.",
    "- Use the cognee-remember skill to ingest new information into the permanent graph.",
    "- Use the cognee-sync skill to bridge session data into the permanent graph.",
  ].join("\n");
}
