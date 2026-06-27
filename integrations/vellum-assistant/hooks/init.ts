/**
 * init hook — fires once when the plugin is registered (on boot or install).
 *
 * Replaces the Claude Code SessionStart hook. Spawns session-start.py which:
 *   1. Loads config (file + env vars)
 *   2. Computes a session ID for this conversation
 *   3. Connects to Cognee Cloud or boots a local server
 *   4. Registers the current session as an active agent connection
 *   5. Starts the idle watcher + exit watcher
 *
 * The script outputs a systemMessage + additionalContext we can log and store
 * for later injection.
 */

import type { PluginInitContext } from "@vellumai/plugin-api";
import { runPythonScript, buildSessionStartPayload, sessionKey, extractSystemMessage } from "../src/bridge.ts";

export default async function init(ctx: PluginInitContext): Promise<void> {
  const cwd = process.cwd();
  // Use the plugin storage dir as a stable conversation identifier for init.
  // The actual conversation-specific session is resolved per user-prompt-submit.
  const conversationId = ctx.pluginStorageDir
    ? ctx.pluginStorageDir.split("/").pop() ?? "vellum-session"
    : "vellum-session";

  const env: Record<string, string> = {};
  env.COGNEE_SESSION_KEY = sessionKey(conversationId);

  try {
    const result = await runPythonScript(
      "session-start.py",
      buildSessionStartPayload(conversationId, cwd),
      [],
      env,
    );

    if (result.exitCode !== 0) {
      ctx.logger.warn({ stderr: result.stderr }, "cognee session-start.py exited non-zero");
    }

    const message = extractSystemMessage(result);
    if (message) {
      ctx.logger.info({ message }, "cognee memory initialized");
    }
  } catch (err) {
    // Non-fatal: the plugin should not block the assistant from starting.
    ctx.logger.warn({ err: String(err) }, "cognee session-start.py failed (non-fatal)");
  }
}
