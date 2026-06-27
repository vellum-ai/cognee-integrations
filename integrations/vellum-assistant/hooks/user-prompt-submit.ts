/**
 * user-prompt-submit hook — fires once per user turn, after messages are
 * assembled and before the agent loop runs.
 *
 * Replaces the Claude Code UserPromptSubmit hook. Spawns session-context-lookup.py
 * which searches Cognee memory (session cache + permanent knowledge graph) and
 * returns relevant context. The context is injected into latestMessages so the
 * model sees it.
 *
 * Also spawns store-user-prompt.py (async/fire-and-forget) to stage the prompt
 * for later pairing with the assistant's response on Stop.
 */

import type { UserPromptSubmitContext, Message } from "@vellumai/plugin-api";
import {
  runPythonScript,
  runPythonScriptDetached,
  buildPromptLookupPayload,
  buildStorePromptPayload,
  sessionKey,
  extractAdditionalContext,
} from "../src/bridge.ts";

export default async function userPromptSubmit(
  ctx: UserPromptSubmitContext,
): Promise<Partial<UserPromptSubmitContext> | void> {
  const prompt = ctx.prompt;
  if (!prompt || prompt.length < 5) {
    return;
  }

  const conversationId = ctx.conversationId;
  const cwd = process.cwd();
  const env: Record<string, string> = {};
  env.COGNEE_SESSION_KEY = sessionKey(conversationId);

  // 1. Context lookup (synchronous — the model needs the results before answering).
  try {
    const result = await runPythonScript(
      "session-context-lookup.py",
      buildPromptLookupPayload(prompt, conversationId, cwd),
      [],
      env,
    );

    const additionalContext = extractAdditionalContext(result);
    if (additionalContext) {
      // Inject the Cognee context as a system message the model will see.
      const contextMessage: Message = {
        role: "system",
        content: additionalContext,
      };
      ctx.latestMessages.push(contextMessage);
    }
  } catch {
    // Non-fatal: the turn proceeds without Cognee context.
  }

  // 2. Stage the prompt (async — pairs with the assistant response on Stop).
  try {
    runPythonScriptDetached(
      "store-user-prompt.py",
      buildStorePromptPayload(prompt, conversationId, cwd),
      [],
      env,
    );
  } catch {
    // Fire-and-forget: never throw.
  }
}
