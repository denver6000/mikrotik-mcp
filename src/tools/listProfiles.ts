import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, searchProfiles } from "../config/load.ts";
import { currentEnvironment, type LookupEnvironment } from "../config/paths.ts";
import type { ResolvedProfile } from "../config/schema.ts";

/** A profile as exposed to the model — describes auth without revealing it. */
function summarise(profile: ResolvedProfile) {
  const auth =
    profile.auth.type === "key"
      ? { type: "key" as const, keyPath: profile.auth.path }
      : profile.auth.type === "password"
        ? { type: "password" as const, passwordEnv: profile.auth.passwordEnv }
        : { type: "agent" as const };

  return {
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth,
    hostKeyPolicy: profile.hostKey.policy,
    readOnly: profile.readOnly,
    timeoutMs: profile.timeoutMs,
    tags: profile.tags,
    ...(profile.description === undefined ? {} : { description: profile.description }),
    source: profile.source,
  };
}

function render(
  profiles: ResolvedProfile[],
  loaded: ReturnType<typeof loadConfig>,
  query: string | undefined,
): string {
  const lines: string[] = [];

  if (profiles.length === 0) {
    lines.push(
      query
        ? `No profiles match '${query}'.`
        : "No router profiles are configured.",
      "",
      "Config files searched, highest precedence first:",
      ...loaded.searched.map((p) => `  ${p}`),
    );
  } else {
    lines.push(`${profiles.length} profile${profiles.length === 1 ? "" : "s"}${query ? ` matching '${query}'` : ""}:`, "");
    for (const p of profiles) {
      const flags = [
        p.readOnly ? "read-only" : "read-write",
        `host key: ${p.hostKey.policy}`,
        `auth: ${p.auth.type}`,
      ].join(", ");
      lines.push(`- ${p.name} — ${p.username}@${p.host}:${p.port} (${flags})`);
      if (p.description) lines.push(`    ${p.description}`);
      if (p.tags.length) lines.push(`    tags: ${p.tags.join(", ")}`);
      lines.push(`    from: ${p.source}`);
    }
  }

  if (loaded.issues.length) {
    lines.push("", "Config problems:");
    for (const issue of loaded.issues) lines.push(`  ${issue.path} — ${issue.message}`);
  }

  return lines.join("\n");
}

export function registerListProfilesTool(
  server: McpServer,
  e: LookupEnvironment = currentEnvironment(),
): void {
  server.registerTool(
    "mikrotik_list_profiles",
    {
      title: "List MikroTik router profiles",
      description:
        "Search the configured MikroTik router profiles. Config files are re-read on every call. " +
        "Returns connection details and whether each profile is read-only. Never returns secrets — " +
        "passwords and passphrases live in environment variables, and only the variable name is shown. " +
        "Call this first to discover the profile name that mikrotik_exec needs.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against name, host, description and tags. Omit to list all."),
      },
      outputSchema: {
        profiles: z.array(z.looseObject({ name: z.string(), host: z.string() })),
        sources: z.array(z.string()).describe("Config files that were loaded, in precedence order."),
        searched: z.array(z.string()).describe("Every path consulted, whether or not it exists."),
        issues: z.array(z.object({ path: z.string(), message: z.string() })),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const loaded = loadConfig(e);
      const matches = searchProfiles(loaded, query);
      return {
        content: [{ type: "text", text: render(matches, loaded, query) }],
        structuredContent: {
          profiles: matches.map(summarise),
          sources: loaded.sources,
          searched: loaded.searched,
          issues: loaded.issues,
        },
      };
    },
  );
}
