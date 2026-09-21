import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LookupEnvironment } from "../src/config/paths.ts";

export interface Sandbox {
  dir: string;
  home: string;
  cwd: string;
  env: LookupEnvironment;
  /** Write a config file inside the sandbox and return its absolute path. */
  write(relativePath: string, contents: unknown): string;
}

/** An isolated filesystem + environment so tests never read the real user's config. */
export function sandbox(vars: Record<string, string> = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "mikrotik-mcp-test-"));
  const home = join(dir, "home");
  const cwd = join(dir, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const env: LookupEnvironment = {
    // A deliberately empty environment: no inherited SSH_AUTH_SOCK, XDG or APPDATA.
    env: { ...vars },
    cwd,
    home,
    platform: "linux",
  };

  return {
    dir,
    home,
    cwd,
    env,
    write(relativePath, contents) {
      const path = join(dir, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
      return path;
    },
  };
}
