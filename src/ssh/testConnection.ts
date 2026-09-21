import { ProfileNotFoundError, requireProfile } from "../config/load.ts";
import { currentEnvironment, type LookupEnvironment } from "../config/paths.ts";
import { execCommand, SshError } from "./exec.ts";

/** A harmless read that exists on every RouterOS version. */
export const PROBE_COMMAND = "/system identity print";

export interface ConnectionTest {
  text: string;
  ok: boolean;
}

/**
 * Connect to one profile, run a harmless read, and report what happened.
 *
 * Backs `mikrotik-mcp --test <profile>`, so a setup can be proven end to end
 * against a real router without going through an agent.
 */
export async function testConnection(
  profileName: string,
  e: LookupEnvironment = currentEnvironment(),
): Promise<ConnectionTest> {
  let profile;
  try {
    profile = requireProfile(profileName, e);
  } catch (error) {
    if (error instanceof ProfileNotFoundError) return { text: `${error.message}\n`, ok: false };
    throw error;
  }

  const target = `${profile.username}@${profile.host}:${profile.port}`;
  const lines = [`Connecting to '${profile.name}' (${target}) as ${profile.auth.type}...`];

  try {
    const result = await execCommand(profile, PROBE_COMMAND, e);
    lines.push(
      `  host key   ${result.hostKeyFingerprint} (accepted by policy '${profile.hostKey.policy}')`,
      `  command    ${PROBE_COMMAND}`,
      `  exit code  ${result.exitCode ?? "none reported"}`,
      `  took       ${result.durationMs}ms`,
      "",
      result.stdout.trimEnd() || "(no output)",
    );
    if (result.stderr.trim()) lines.push("", `stderr: ${result.stderr.trimEnd()}`);
    lines.push("", "OK.");
    return { text: lines.join("\n") + "\n", ok: true };
  } catch (error) {
    lines.push("", error instanceof SshError ? error.message : String(error), "", "FAILED.");
    return { text: lines.join("\n") + "\n", ok: false };
  }
}
