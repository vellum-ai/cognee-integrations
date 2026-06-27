/**
 * cognee-recall tool — model-visible tool that searches Cognee memory.
 *
 * Replaces the Claude Code cognee-recall agent. The model can call this tool
 * for deeper or cross-session searches when the automatic context injected
 * by the user-prompt-submit hook is insufficient.
 *
 * The tool shells out to cognee-search.sh which queries the running Cognee
 * server (/api/v1/recall) — the source of truth — and falls back to cognee-cli
 * only if the server is unreachable.
 */

import type { ToolDefinition, ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";
import { spawn } from "bun";
import { join } from "node:path";
import { PLUGIN_ROOT, sessionKey } from "../src/bridge.ts";

interface RecallParams {
  query: string;
  top_k?: number;
  scope?: "session" | "graph" | "auto";
}

export const cogneeRecall: ToolDefinition = {
  name: "cognee_recall",
  description:
    "Search Cognee memory (session cache and permanent knowledge graph) to retrieve relevant context. " +
    "Session memory is auto-searched on every prompt via hooks; use this tool for deeper or cross-session searches. " +
    "Can filter by scope: 'session' for current session only, 'graph' for permanent graph only, 'auto' for both.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query — a natural language question or keywords.",
      },
      top_k: {
        type: "number",
        description: "Maximum number of results to return (default: 10).",
      },
      scope: {
        type: "string",
        enum: ["session", "graph", "auto"],
        description: "Search scope: 'session' for current session cache, 'graph' for permanent knowledge graph, 'auto' for both (default).",
      },
    },
    required: ["query"],
  },
  riskLevel: "low",

  async execute(
    ctx: ToolContext,
    params: RecallParams,
  ): Promise<ToolExecutionResult> {
    const query = params.query;
    if (!query) {
      return { content: [{ type: "text", text: "Error: no query provided" }] };
    }

    const topK = String(params.top_k ?? 10);
    const scopeFlag = params.scope === "session" ? "--session" : params.scope === "graph" ? "--graph" : "";
    const args = [query, topK];
    if (scopeFlag) args.push(scopeFlag);

    const env: Record<string, string> = {
      ...process.env,
      COGNEE_SESSION_KEY: sessionKey(ctx.conversationId),
    };

    const scriptPath = join(PLUGIN_ROOT, "scripts", "cognee-search.sh");

    try {
      const proc = spawn({
        cmd: ["bash", scriptPath, ...args],
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0 && !stdout.trim()) {
        return {
          content: [{
            type: "text",
            text: `Cognee search failed (exit ${exitCode}): ${stderr.trim() || "no output"}`,
          }],
        };
      }

      // Parse the JSON results from stdout.
      let results: unknown;
      try {
        results = JSON.parse(stdout.trim());
      } catch {
        // Non-JSON output (e.g. CLI fallback) — return as plain text.
        return { content: [{ type: "text", text: stdout.trim() }] };
      }

      if (Array.isArray(results)) {
        if (results.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No results found. The server returned an empty list (authoritative). " +
                "Try /cognee-memory:cognee-sync to sync session data to the permanent graph, " +
                "or /cognee-memory:cognee-remember to ingest new data.",
            }],
          };
        }

        // Format results for the model.
        const lines: string[] = [];
        for (const entry of results) {
          const e = entry as Record<string, unknown>;
          const source = (e._source as string) ?? (e.source as string) ?? "unknown";
          const question = (e.question as string) ?? "";
          const answer = (e.answer as string) ?? "";
          const content = (e.content as string) ?? (e.text as string) ?? "";
          const origin = (e.origin_function as string) ?? "";
          const status = (e.status as string) ?? "";

          if (source === "graph_context" || source === "graph") {
            lines.push(`[graph] ${content.slice(0, 500)}`);
          } else if (source === "trace") {
            lines.push(`[trace] ${origin} — ${status}`);
          } else if (question || answer) {
            lines.push(`[session] Q: ${question.slice(0, 200)}`);
            if (answer) lines.push(`  A: ${answer.slice(0, 300)}`);
          } else if (content) {
            lines.push(`[${source}] ${content.slice(0, 500)}`);
          }
        }

        return {
          content: [{
            type: "text",
            text: `Cognee memory search results (${results.length} hits):\n\n${lines.join("\n")}`,
          }],
        };
      }

      // Error envelope from the server.
      const errObj = results as Record<string, unknown>;
      if (errObj.error) {
        return {
          content: [{
            type: "text",
            text: `Cognee search error: ${errObj.error}`,
          }],
        };
      }

      return { content: [{ type: "text", text: stdout.trim() }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Cognee search failed: ${String(err)}`,
        }],
      };
    }
  },
};

export default cogneeRecall;
