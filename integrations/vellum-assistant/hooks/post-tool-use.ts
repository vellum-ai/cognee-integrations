/**
 * post-tool-use hook — fires after each tool returns, before the result
 * rejoins the history sent to the provider.
 *
 * Stores a TraceEntry to the Cognee session cache. Fire-and-forget,
 * never blocks the agent loop.
 */

import type { PostToolUseContext } from "@vellumai/plugin-api";

import { hookLog, touchActivity } from "../src/plugin-common.ts";
import { setSessionEnv } from "../src/bridge.ts";
import { storeToolCall, type StoreToolPayload } from "../src/store-to-session.ts";

export default async function postToolUse(
  ctx: PostToolUseContext,
): Promise<void> {
  const conversationId = ctx.conversationId;
  setSessionEnv(conversationId);

  // Extract tool name and I/O from the tool response block.
  const toolResponse = ctx.toolResponse as Record<string, unknown>;
  const toolName = (toolResponse.name as string) ?? (toolResponse.tool_name as string) ?? "unknown";
  const toolInput = toolResponse.input ?? toolResponse.tool_input;
  const toolOutput = toolResponse.content ?? toolResponse.output ?? toolResponse.tool_output ?? "";

  touchActivity();

  const payload: StoreToolPayload = {
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolOutput,
    tool_response: toolResponse,
    conversationId,
  };

  try {
    await storeToolCall(payload);
  } catch (err) {
    hookLog("post_tool_use_store_failed", {
      tool: toolName,
      error: String(err).slice(0, 200),
    });
  }
}
