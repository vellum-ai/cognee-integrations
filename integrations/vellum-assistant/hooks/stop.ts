/**
 * stop hook — fires once per run, when the loop has committed to ending the
 * turn.
 *
 * Replaces the Claude Code Stop hook. Spawns store-to-session.py --stop
 * (async/fire-and-forget) which writes the final assistant message as a
 * QAEntry to the Cognee session cache, pairing it with the staged prompt
 * from the user-prompt-submit hook.
 */

import type { StopContext, Message } from "@vellumai/plugin-api";
import {
  runPythonScriptDetached,
  buildStopPayload,
  sessionKey,
} from "../src/bridge.ts";

/** Extract the last assistant message's text from the conversation history. */
function lastAssistantText(messages: ReadonlyArray<Message>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        // Extract text blocks from the content array.
        const texts = msg.content
          .filter((b: unknown) => {
            const block = b as Record<string, unknown>;
            return block?.type === "text" && typeof block.text === "string";
          })
          .map((b: unknown) => (b as Record<string, unknown>).text as string);
        if (texts.length > 0) {
          return texts.join("\n");
        }
      }
    }
  }
  return "";
}

export default async function stop(ctx: StopContext): Promise<void> {
  const conversationId = ctx.conversationId;
  const assistantMessage = lastAssistantText(ctx.messages);

  if (!assistantMessage || assistantMessage.length < 5) {
    return;
  }

  const env: Record<string, string> = {};
  env.COGNEE_SESSION_KEY = sessionKey(conversationId);

  try {
    runPythonScriptDetached(
      "store-to-session.py",
      buildStopPayload(assistantMessage, conversationId),
      ["--stop"],
      env,
    );
  } catch {
    // Fire-and-forget: never throw.
  }
}
