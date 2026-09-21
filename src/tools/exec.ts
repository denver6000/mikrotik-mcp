import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProfileNotFoundError, requireProfile } from "../config/load.ts";
import { currentEnvironment, type LookupEnvironment } from "../config/paths.ts";
import { execCommand, SshError } from "../ssh/exec.ts";
import { classifyCommand } from "../ssh/policy.ts";

const MAX_COMMAND_LENGTH = 4000;

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
    structuredContent: {
      ok: false,
      stdout: "",
      stderr: text,
      exitCode: null,
      durationMs: 0,
    },
  };
}

export function registerExecTool(
  server: McpServer,
  e: LookupEnvironment = currentEnvironment(),
): void {
  server.registerTool(
    "mikrotik_exec",
    {
      title: "Run a RouterOS command over SSH",
      description:
        "Run a single RouterOS command on a configured router over SSH and return its output. " +
        "Stateless: each call opens a fresh connection and closes it before returning, so there is no " +
        "session, working directory or shell state carried between calls — send absolute command paths " +
        "such as '/system resource print'. Profiles are read-only by default, in which case commands " +
        "that would change the router are refused before connecting. Use mikrotik_list_profiles to find " +
        "profile names. " +
        "Item numbers printed by RouterOS are NOT stable: they are reassigned per session and again on " +
        "the next print, and every call here is a new session. Never pass a number seen in an earlier " +
        "call to a later one — it will act on whatever holds that number now. Select by predicate " +
        "instead, e.g. /ip firewall filter remove [find where comment=\"x\"]. " +
        "See mikrotik_search_docs for more.",
      inputSchema: {
        profile: z.string().min(1).describe("Profile name from mikrotik_list_profiles."),
        command: z
          .string()
          .min(1)
          .max(MAX_COMMAND_LENGTH)
          .describe("RouterOS command, e.g. '/system resource print' or '/ip address print detail'."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .optional()
          .describe("Override the profile's timeout for this call."),
      },
      outputSchema: {
        ok: z.boolean(),
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().nullable(),
        durationMs: z.number(),
        hostKeyFingerprint: z.string().optional(),
      },
      annotations: {
        // The tool itself can change the router when the profile allows it.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ profile: profileName, command, timeoutMs }) => {
      let profile;
      try {
        profile = requireProfile(profileName, e);
      } catch (error) {
        if (error instanceof ProfileNotFoundError) return errorResult(error.message);
        throw error;
      }

      const trimmed = command.trim();
      if (!trimmed) return errorResult("The command is empty.");
      if (trimmed.includes("\0")) return errorResult("The command contains a NUL byte.");

      if (profile.readOnly) {
        const verdict = classifyCommand(trimmed);
        if (!verdict.readOnly) {
          return errorResult(
            `Refused: profile '${profile.name}' is read-only and ${verdict.reason}` +
              (verdict.offending ? ` in: ${verdict.offending}` : "") +
              `.\nTo allow writes, set "readOnly": false on that profile in ${profile.source}. ` +
              `For real enforcement, log in as a RouterOS user whose group grants read access only.`,
          );
        }
      }

      try {
        const result = await execCommand(profile, trimmed, e, timeoutMs ?? profile.timeoutMs);
        const failed = result.exitCode !== null && result.exitCode !== 0;
        const header = `${profile.username}@${profile.host}:${profile.port} $ ${trimmed}`;
        const body = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
        const footer = failed
          ? `\n[exit code ${result.exitCode}]`
          : result.stdout.trim() || result.stderr.trim()
            ? ""
            : "\n[no output]";

        return {
          ...(failed ? { isError: true } : {}),
          content: [{ type: "text" as const, text: `${header}\n${body}${footer}` }],
          structuredContent: {
            ok: !failed,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            hostKeyFingerprint: result.hostKeyFingerprint,
          },
        };
      } catch (error) {
        if (error instanceof SshError) return errorResult(error.message);
        return errorResult(`Unexpected failure running on '${profile.name}': ${String(error)}`);
      }
    },
  );
}
