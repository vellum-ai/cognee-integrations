/**
 * shutdown hook — fires once when the assistant tears down the plugin
 * (process exit, unload).
 *
 *   1. Triggers a final session-to-graph sync (with unregister)
 *   2. Clears the server-ready marker
 */

import type { PluginShutdownContext } from "@vellumai/plugin-api";

import {
  getSessionKey,
  hookLog,
  clearServerReady,
} from "../src/plugin-common.ts";
import { syncSessionToGraph } from "../src/sync-session-to-graph.ts";

export default async function shutdown(_ctx: PluginShutdownContext): Promise<void> {
  // The session key should still be in the env from earlier hooks.
  const sessionKey = getSessionKey();
  if (!sessionKey) {
    clearServerReady();
    return;
  }

  // 1. Final graph sync with unregister.
  try {
    await syncSessionToGraph(true);
  } catch (err) {
    hookLog("shutdown_sync_failed", { error: String(err).slice(0, 200) });
  }

  // 2. Clear the server-ready marker.
  clearServerReady();

  hookLog("shutdown_complete");
}
