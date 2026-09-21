import { existsSync } from "node:fs";
import { loadConfig } from "./load.ts";
import { currentEnvironment, type LookupEnvironment } from "./paths.ts";
import { inspectKeyFile } from "../ssh/keyFile.ts";
import { knownHostsPaths } from "../ssh/exec.ts";

export interface ConfigReport {
  text: string;
  /** False when a config file is broken or nothing is configured at all. */
  ok: boolean;
}

/**
 * A human-readable account of what the server would load right now — which
 * paths it checks, what it found, and what it could not parse. Printed by
 * `mikrotik-mcp --check-config` so a config can be debugged without an agent.
 */
export function describeConfig(e: LookupEnvironment = currentEnvironment()): ConfigReport {
  const loaded = loadConfig(e);
  const lines: string[] = [];

  lines.push("Config search path (highest precedence first):");
  for (const path of loaded.searched) {
    const mark = loaded.sources.includes(path)
      ? "loaded"
      : existsSync(path)
        ? "FAILED"
        : "      ";
    lines.push(`  ${mark} ${path}`);
  }

  lines.push("");
  if (loaded.profiles.size === 0) {
    lines.push("No profiles found.");
  } else {
    lines.push(`Profiles (${loaded.profiles.size}):`);
    for (const p of loaded.profiles.values()) {
      lines.push(`  ${p.name}`);
      lines.push(`    ssh       ${p.username}@${p.host}:${p.port}`);
      if (p.auth === null) {
        lines.push(`    auth      NONE DECLARED — add "auth" to the profile or to "defaults"`);
      } else if (p.auth.type === "password") {
        const set = e.env[p.auth.passwordEnv] ? "" : " — NOT SET";
        lines.push(`    auth      password (from $${p.auth.passwordEnv}${set})`);
      } else if (p.auth.type === "agent") {
        lines.push(`    auth      agent (depends on the environment the server is launched from)`);
      } else {
        const key = inspectKeyFile(p, e);
        lines.push(`    auth      key  ${key?.path ?? p.auth.path}`);
        if (key?.problem) lines.push(`              PROBLEM: ${key.problem}`);
        else if (key?.keyType) lines.push(`              ${key.keyType}, ${key.fingerprint}`);
        if (key?.permissionWarning) lines.push(`              WARNING: ${key.permissionWarning}`);
      }

      if (p.hostKey.policy === "known-hosts") {
        lines.push(`    host key  known-hosts: ${knownHostsPaths(p, e).join(", ")}`);
      } else {
        lines.push(`    host key  ${p.hostKey.policy}`);
      }
      lines.push(`    writes    ${p.readOnly ? "refused (readOnly)" : "ALLOWED"}`);
      lines.push(`    from      ${p.source}`);
    }
  }

  if (loaded.issues.length) {
    lines.push("", "Problems:");
    for (const issue of loaded.issues) {
      lines.push(`  ${issue.path}`);
      lines.push(`    ${issue.message}`);
    }
  }

  return {
    text: lines.join("\n") + "\n",
    ok:
      loaded.issues.length === 0 &&
      loaded.profiles.size > 0 &&
      // An unusable key is as much a failure as an unparseable config file.
      ![...loaded.profiles.values()].some((p) => inspectKeyFile(p, e)?.problem),
  };
}
