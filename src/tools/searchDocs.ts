import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadCorpus, type DocSection } from "../docs/corpus.ts";
import { searchDocs } from "../docs/search.ts";

const MAX_BODY_CHARS = 1500;

function render(section: DocSection): string {
  const versions = section.versions.map((v) => `v${v}`).join(", ");
  const body =
    section.body.length > MAX_BODY_CHARS
      ? `${section.body.slice(0, MAX_BODY_CHARS)}\n…[truncated]`
      : section.body;
  return [`## ${section.heading}`, `_${section.docTitle} · RouterOS ${versions}_`, "", body].join(
    "\n",
  );
}

export function registerSearchDocsTool(server: McpServer): void {
  server.registerTool(
    "mikrotik_search_docs",
    {
      title: "Search the RouterOS reference",
      description:
        "Search bundled RouterOS reference material for command syntax, idioms and version differences. " +
        "Covers RouterOS v6 and v7. Use this before composing an unfamiliar command, and especially " +
        "before any write — it documents traps such as item numbers being unstable between calls. " +
        "Offline and read-only; it does not touch any router.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "What you need to do, in keywords — e.g. 'firewall filter print', 'bgp peer v7', 'remove rule safely'.",
          ),
        version: z
          .union([z.literal(6), z.literal(7)])
          .optional()
          .describe(
            "Limit results to sections that apply to this RouterOS major version. Read it from /system resource print.",
          ),
        limit: z.number().int().min(1).max(10).optional().describe("Maximum sections to return. Default 3."),
      },
      outputSchema: {
        results: z.array(
          z.object({
            doc: z.string(),
            heading: z.string(),
            versions: z.array(z.number()),
            score: z.number(),
            body: z.string(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, version, limit }) => {
      const corpus = loadCorpus();
      const hits = searchDocs(corpus, query, {
        ...(version === undefined ? {} : { version }),
        limit: limit ?? 3,
      });

      if (hits.length === 0) {
        const topics = [...new Set(corpus.map((s) => s.docTitle))];
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No reference section matches '${query}'` +
                (version ? ` for RouterOS v${version}` : "") +
                `.\n\nAvailable topics:\n${topics.map((t) => `  - ${t}`).join("\n")}`,
            },
          ],
          structuredContent: { results: [] },
        };
      }

      return {
        content: [{ type: "text" as const, text: hits.map((h) => render(h.section)).join("\n\n---\n\n") }],
        structuredContent: {
          results: hits.map((h) => ({
            doc: h.section.doc,
            heading: h.section.heading,
            versions: h.section.versions,
            score: Number(h.score.toFixed(3)),
            body: h.section.body,
          })),
        },
      };
    },
  );
}
