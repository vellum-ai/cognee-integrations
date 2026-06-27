/**
 * Bridge helper: spawns the Python hook scripts that talk to the Cognee server,
 * and translates between Vellum Assistant hook contexts and the JSON
 * stdin/stdout contract the scripts use (originally designed for Claude Code).
 *
 * The Python scripts are kept as-is (battle-tested: circuit breakers, session
 * management, HTTP transport, venv bootstrapping). These wrappers construct the
 * right payload, feed it to the script on stdin, parse stdout, and return
 * structured results the TypeScript hooks can apply to their contexts.
 */

import { spawn } from "bun";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Absolute path to the plugin root (this directory's parent). */
export const PLUGIN_ROOT = dirname(dirname(new URL(import.meta.url).pathname));

/** Directory containing the Python scripts. */
export const SCRIPTS_DIR = join(PLUGIN_ROOT, "scripts");

/** Plugin state directory (replaces ~/.cognee-plugin/claude-code). */
export const STATE_DIR = join(homedir(), ".cognee-plugin", "vellum-assistant");

/** Shared plugin root (api key cache, venv, server-ready marker). */
export const SHARED_ROOT = join(homedir(), ".cognee-plugin");

/** Persisted conversation→cognee-session map so hooks resolve the same session. */
const SESSION_MAP_FILE = join(STATE_DIR, "session-map.json");

/** Env vars the Python scripts read. We set them before spawning. */
function buildPythonEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    // Tell the Python scripts where their state lives.
    COGNEE_PLUGIN_STATE_DIR: SHARED_ROOT,
    // Vellum-specific overrides (the scripts read these via _plugin_common).
    COGNEE_AGENT_NAME: process.env.COGNEE_AGENT_NAME ?? "vellum-assistant-agent",
    COGNEE_SESSION_PREFIX: process.env.COGNEE_SESSION_PREFIX ?? "vellum",
    // Pass the plugin root so scripts can find each other.
    VELLUM_PLUGIN_ROOT: PLUGIN_ROOT,
    ...extra,
  };
}

/** Read the persisted session map (conversationId → cognee session id). */
function readSessionMap(): Record<string, string> {
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      return JSON.parse(readFileSync(SESSION_MAP_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

/** Write the session map. */
function writeSessionMap(map: Record<string, string>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
  } catch {}
}

/** Resolve or create a stable cognee session id for a conversation. */
export function resolveSessionId(conversationId: string): string {
  const map = readSessionMap();
  if (map[conversationId]) {
    return map[conversationId];
  }
  const prefix = process.env.COGNEE_SESSION_PREFIX ?? "vellum";
  const id = `${prefix}_${conversationId}`;
  map[conversationId] = id;
  writeSessionMap(map);
  return id;
}

/** Get the conversation's session key (used by the Python scripts as COGNEE_SESSION_KEY). */
export function sessionKey(conversationId: string): string {
  return conversationId;
}

/** Result from a Python script invocation. */
export interface ScriptResult {
  /** Parsed JSON stdout, or null if the script produced no JSON. */
  json: Record<string, unknown> | null;
  /** Raw stdout text (for scripts that print markdown instead of JSON). */
  raw: string;
  /** Exit code. 0 = success. */
  exitCode: number;
  /** Stderr text (for diagnostics). */
  stderr: string;
}

/**
 * Spawn a Python script, feed it a JSON payload on stdin, and collect stdout.
 *
 * The Python scripts follow the Claude Code hook contract: read JSON from stdin,
 * write JSON (or plain text) to stdout, log diagnostics to stderr.
 */
export async function runPythonScript(
  scriptName: string,
  payload: Record<string, unknown>,
  args: string[] = [],
  extraEnv?: Record<string, string>,
): Promise<ScriptResult> {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  const env = buildPythonEnv(extraEnv);

  const stdin = JSON.stringify(payload);
  const proc = spawn({
    cmd: ["python3", scriptPath, ...args],
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  let json: Record<string, unknown> | null = null;
  const raw = stdout.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // Script produced non-JSON output (e.g. markdown from pre-compact.py).
    }
  }

  return { json, raw, exitCode, stderr };
}

/**
 * Run a Python script as fire-and-forget (async write hooks).
 * Does not wait for the script to complete.
 */
export function runPythonScriptDetached(
  scriptName: string,
  payload: Record<string, unknown>,
  args: string[] = [],
  extraEnv?: Record<string, string>,
): void {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  const env = buildPythonEnv(extraEnv);
  const stdin = JSON.stringify(payload);

  try {
    spawn({
      cmd: ["python3", scriptPath, ...args],
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch {
    // Fire-and-forget: never throw.
  }
}

/** Extract additionalContext from a script's hookSpecificOutput. */
export function extractAdditionalContext(result: ScriptResult): string | null {
  if (!result.json) return null;
  const hso = result.json.hookSpecificOutput as Record<string, unknown> | undefined;
  if (!hso) return null;
  const ctx = hso.additionalContext as string | undefined;
  return ctx ?? null;
}

/** Extract systemMessage from a script's hookSpecificOutput. */
export function extractSystemMessage(result: ScriptResult): string | null {
  if (!result.json) return null;
  const hso = result.json.hookSpecificOutput as Record<string, unknown> | undefined;
  if (!hso) return null;
  const msg = hso.systemMessage as string | undefined;
  return msg ?? null;
}

/** Build the session-start payload for the Python script. */
export function buildSessionStartPayload(conversationId: string, cwd: string): Record<string, unknown> {
  return {
    session_id: conversationId,
    cwd,
  };
}

/** Build the user-prompt-submit payload for session-context-lookup.py. */
export function buildPromptLookupPayload(
  prompt: string,
  conversationId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    prompt,
    session_id: conversationId,
    cwd,
  };
}

/** Build the store-user-prompt payload. */
export function buildStorePromptPayload(
  prompt: string,
  conversationId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    prompt,
    session_id: conversationId,
    cwd,
  };
}

/** Build the post-tool-use payload for store-to-session.py. */
export function buildToolUsePayload(
  toolName: string,
  toolInput: unknown,
  toolOutput: unknown,
  conversationId: string,
): Record<string, unknown> {
  return {
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput),
    session_id: conversationId,
  };
}

/** Build the stop payload for store-to-session.py --stop. */
export function buildStopPayload(
  assistantMessage: string,
  conversationId: string,
): Record<string, unknown> {
  return {
    assistant_message: assistantMessage,
    session_id: conversationId,
  };
}

/** Build the pre-compact payload. */
export function buildCompactPayload(conversationId: string): Record<string, unknown> {
  return {
    session_id: conversationId,
  };
}

/** Build the session-end payload for sync-session-to-graph.py. */
export function buildSessionEndPayload(conversationId: string): Record<string, unknown> {
  return {
    session_id: conversationId,
    hook_event_name: "SessionEnd",
  };
}
