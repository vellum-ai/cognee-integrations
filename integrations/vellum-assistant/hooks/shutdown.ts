/**
 * shutdown hook — fires once when the assistant tears down the plugin
 * (process exit, unload).
 *
 * Replaces the Claude Code SessionEnd hook. Spawns sync-session-to-graph.py
 * --session-end which triggers a detached final sync worker that bridges
 * session cache entries into the permanent knowledge graph and unregisters
 * the agent connection.
 */

import type { PluginShutdownContext } from "@vellumai/plugin-api";
import { runPythonScript, buildSessionEndPayload } from "../src/bridge.ts";

export default async function shutdown(_ctx: PluginShutdownContext): Promise<void> {
  // The session-end sync is best-effort. We don't have the conversationId in
  // the shutdown context, but the Python script resolves the session from
  // the COGNEE_SESSION_KEY env var (set by earlier hooks) and from its own
  // session map files.
  try {
    await runPythonScript(
      "sync-session-to-graph.py",
      buildSessionEndPayload(""),
      ["--session-end"],
    );
  } catch {
    // Best-effort: never throw on shutdown.
  }
}
