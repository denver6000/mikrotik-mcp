import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";

export const CONFIG_ENV_VAR = "MIKROTIK_MCP_CONFIG";
export const PROJECT_CONFIG_NAME = ".mikrotik-mcp.json";

export interface LookupEnvironment {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
}

export function currentEnvironment(): LookupEnvironment {
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
  };
}

/** Expand a leading '~' and any $VAR / ${VAR} references in a path. */
export function expandPath(input: string, e: LookupEnvironment = currentEnvironment()): string {
  let out = input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const value = e.env[a ?? b];
    return value === undefined ? m : value;
  });
  if (out === "~") out = e.home;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = join(e.home, out.slice(2));
  return out;
}

/**
 * Config files to consult, highest precedence first.
 *
 * 1. $MIKROTIK_MCP_CONFIG — one or more explicit paths (path-separator delimited)
 * 2. .mikrotik-mcp.json in the working directory, then each parent directory
 * 3. the per-user config directory
 * 4. ~/.mikrotik-mcp.json
 *
 * Every file that exists is loaded; when two files define the same profile
 * name, the one earlier in this list wins.
 */
export function configSearchPaths(e: LookupEnvironment = currentEnvironment()): string[] {
  const paths: string[] = [];
  const push = (p: string) => {
    const abs = resolve(expandPath(p, e));
    if (!paths.includes(abs)) paths.push(abs);
  };

  const explicit = e.env[CONFIG_ENV_VAR];
  if (explicit) {
    for (const part of explicit.split(delimiter)) {
      if (part.trim()) push(part.trim());
    }
  }

  let dir = resolve(e.cwd);
  const root = parse(dir).root;
  for (;;) {
    push(join(dir, PROJECT_CONFIG_NAME));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (e.platform === "win32") {
    const appData = e.env["APPDATA"];
    if (appData) push(join(appData, "mikrotik-mcp", "config.json"));
  }
  const xdg = e.env["XDG_CONFIG_HOME"];
  push(xdg && isAbsolute(xdg) ? join(xdg, "mikrotik-mcp", "config.json") : join(e.home, ".config", "mikrotik-mcp", "config.json"));
  push(join(e.home, ".mikrotik-mcp.json"));

  return paths;
}

/** Paths that were named explicitly and must therefore exist. */
export function requiredConfigPaths(e: LookupEnvironment = currentEnvironment()): string[] {
  const explicit = e.env[CONFIG_ENV_VAR];
  if (!explicit) return [];
  return explicit
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(expandPath(p, e)));
}
