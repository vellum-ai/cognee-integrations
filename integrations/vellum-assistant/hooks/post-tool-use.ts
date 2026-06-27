/**
 * post-tool-use hook — fires after each tool returns, before the result
 * rejoins the history sent to the provider.
 *
 * Replaces the Claude Code PostToolUse hook. Spawns store-to-session.py
 * (async/fire-and-forget) which writes a TraceEntry to the Cognee session
 * cache. The trace captures tool name, params, output, and status.
 */

import type { PostToolUseContext } from "@vellumai/plugin-api";
import {
  runPythonScriptDetached,
  buildToolUsePayload,
  sessionKey,
} from "../src/bridge.ts";

export default async function postToolUse(
  ctx: PostToolUseContext,
): Promise<void> {
  const conversationId = ctx.conversationId;

  // Extract tool name and I/O from the tool response block.
  // The toolResponse shape varies; we normalize to what the Python script expects.
  const toolResponse = ctx.toolResponse as Record<string, unknown>;
  const toolName = (toolResponse.name as string) ?? (toolResponse.tool_name as string) ?? "unknown";
  const toolInput = toolResponse.input ?? toolResponse.tool_input;
  const toolOutput = toolResponse.content ?? toolResponse.output ?? toolResponse.tool_output ?? "";

  const env: Record<string, string> = {};
  env.COGNEE_SESSION_KEY = sessionKey(conversationId);

  try {
    runPythonScriptDetached(
      "store-to-session.py",
      buildToolUsePayload(toolName, toolInput, toolOutput, conversationId),
      [],
      env,
    );
  } catch {
    // Fire-and-forget: never throw.
  }
}
