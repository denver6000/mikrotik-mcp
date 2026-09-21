import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ConfigSchema,
  DEFAULT_PORT,
  DEFAULT_READ_ONLY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USERNAME,
  type Auth,
  type Config,
  type Defaults,
  type Profile,
  type ResolvedProfile,
} from "./schema.ts";
import {
  configSearchPaths,
  currentEnvironment,
  requiredConfigPaths,
  type LookupEnvironment,
} from "./paths.ts";

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface LoadedConfig {
  /** Resolved profiles, keyed by name. Earlier files win on collision. */
  profiles: Map<string, ResolvedProfile>;
  /** Config files that were found and parsed, in precedence order. */
  sources: string[];
  /** Files that exist but could not be used, plus why. */
  issues: ConfigIssue[];
  /** Every path consulted, whether or not it exists. */
  searched: string[];
}

const DEFAULT_AUTH: Auth = { type: "agent" };

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw error;
  }
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

function resolveProfile(
  name: string,
  profile: Profile,
  defaults: Defaults | undefined,
  source: string,
): ResolvedProfile {
  const hostKey = { ...defaults?.hostKey, ...profile.hostKey };
  return {
    name,
    host: profile.host,
    port: profile.port ?? defaults?.port ?? DEFAULT_PORT,
    username: profile.username ?? defaults?.username ?? DEFAULT_USERNAME,
    auth: profile.auth ?? defaults?.auth ?? DEFAULT_AUTH,
    hostKey: {
      ...hostKey,
      policy: hostKey.policy ?? (hostKey.fingerprintSha256 ? "pinned" : "known-hosts"),
    },
    readOnly: profile.readOnly ?? defaults?.readOnly ?? DEFAULT_READ_ONLY,
    timeoutMs: profile.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(profile.algorithms ?? defaults?.algorithms
      ? { algorithms: { ...defaults?.algorithms, ...profile.algorithms } }
      : {}),
    ...(profile.description === undefined ? {} : { description: profile.description }),
    tags: profile.tags ?? [],
    source,
  };
}

/**
 * Read every config file on the search path and merge them.
 *
 * Nothing is cached: each call hits the filesystem, so edits to a config file
 * take effect on the next tool call without restarting the server.
 */
export function loadConfig(e: LookupEnvironment = currentEnvironment()): LoadedConfig {
  const searched = configSearchPaths(e);
  const required = new Set(requiredConfigPaths(e));
  const profiles = new Map<string, ResolvedProfile>();
  const sources: string[] = [];
  const issues: ConfigIssue[] = [];

  for (const path of searched) {
    let text: string | undefined;
    try {
      text = readIfPresent(path);
    } catch (error) {
      issues.push({ path, message: `cannot be read: ${(error as Error).message}` });
      continue;
    }
    if (text === undefined) {
      if (required.has(path)) {
        issues.push({ path, message: `named by $MIKROTIK_MCP_CONFIG but does not exist` });
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      issues.push({ path, message: `is not valid JSON: ${(error as Error).message}` });
      continue;
    }

    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      issues.push({ path, message: describeZodError(result.error) });
      continue;
    }

    const config: Config = result.data;
    sources.push(path);
    for (const [name, profile] of Object.entries(config.profiles)) {
      // First file to define a name wins; later files are lower precedence.
      if (profiles.has(name)) continue;
      profiles.set(name, resolveProfile(name, profile, config.defaults, path));
    }
  }

  return { profiles, sources, issues, searched };
}

export class ProfileNotFoundError extends Error {
  readonly requested: string;
  readonly loaded: LoadedConfig;

  constructor(requested: string, loaded: LoadedConfig) {
    const known = [...loaded.profiles.keys()];
    const hint = known.length
      ? `Known profiles: ${known.join(", ")}.`
      : `No profiles are defined. Looked in:\n  ${loaded.searched.join("\n  ")}`;
    const problems = loaded.issues.length
      ? `\nConfig problems:\n${loaded.issues.map((i) => `  ${i.path} — ${i.message}`).join("\n")}`
      : "";
    super(`Unknown profile '${requested}'. ${hint}${problems}`);
    this.name = "ProfileNotFoundError";
    this.requested = requested;
    this.loaded = loaded;
  }
}

export function requireProfile(
  name: string,
  e: LookupEnvironment = currentEnvironment(),
): ResolvedProfile {
  const loaded = loadConfig(e);
  const profile = loaded.profiles.get(name);
  if (!profile) throw new ProfileNotFoundError(name, loaded);
  return profile;
}

/** Substring match over name, host, description and tags. */
export function searchProfiles(loaded: LoadedConfig, query?: string): ResolvedProfile[] {
  const all = [...loaded.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!query?.trim()) return all;
  const needle = query.trim().toLowerCase();
  return all.filter((p) =>
    [p.name, p.host, p.description ?? "", ...p.tags].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}
