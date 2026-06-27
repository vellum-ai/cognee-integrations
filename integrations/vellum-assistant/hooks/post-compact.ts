/**
 * post-compact hook — fires after the loop compacts a conversation mid-turn,
 * before the turn resumes.
 *
 * Replaces the Claude Code PreCompact hook. Spawns pre-compact.py which pulls
 * a compact summary from the session cache (recent QAs, trace feedback, graph
 * context) and emits a markdown block. We inject this into the compacted
 * history so the model retains memory context across compaction.
 */

import type { PostCompactContext, Message } from "@vellumai/plugin-api";
import { runPythonScript, buildCompactPayload, sessionKey } from "../src/bridge.ts";

export default async function postCompact(
  ctx: PostCompactContext,
): Promise<Partial<PostCompactContext> | void> {
  const conversationId = ctx.conversationId;
  const env: Record<string, string> = {};
  env.COGNEE_SESSION_KEY = sessionKey(conversationId);

  try {
    const result = await runPythonScript(
      "pre-compact.py",
      buildCompactPayload(conversationId),
      [],
      env,
    );

    // pre-compact.py prints markdown directly to stdout (not JSON).
    const anchor = result.raw.trim();
    if (anchor) {
      // Inject the memory anchor as a system message at the start of history
      // so the model sees it after compaction.
      const anchorMessage: Message = {
        role: "system",
        content: anchor,
      };
      ctx.history.unshift(anchorMessage);
    }
  } catch {
    // Non-fatal: compaction proceeds without the memory anchor.
  }
}
