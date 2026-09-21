import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, requireProfile, searchProfiles, ProfileNotFoundError } from "../src/config/load.ts";
import { configSearchPaths, expandPath } from "../src/config/paths.ts";
import { sandbox } from "./helpers.ts";

describe("config search paths", () => {
  it("puts $MIKROTIK_MCP_CONFIG first and walks up from the working directory", () => {
    const s = sandbox({ MIKROTIK_MCP_CONFIG: join("~", "explicit.json") });
    const paths = configSearchPaths(s.env);

    assert.equal(paths[0], join(s.home, "explicit.json"));
    assert.ok(paths.includes(join(s.cwd, ".mikrotik-mcp.json")));
    assert.ok(paths.includes(join(s.dir, ".mikrotik-mcp.json")), "parent directories are searched");
    assert.ok(paths.includes(join(s.home, ".config", "mikrotik-mcp", "config.json")));
    assert.ok(paths.includes(join(s.home, ".mikrotik-mcp.json")));
  });

  it("expands ~ and environment variables", () => {
    const s = sandbox({ KEYS: "/srv/keys" });
    assert.equal(expandPath("~/.ssh/id_ed25519", s.env), join(s.home, ".ssh/id_ed25519"));
    assert.equal(expandPath("$KEYS/router", s.env), "/srv/keys/router");
    assert.equal(expandPath("${KEYS}/router", s.env), "/srv/keys/router");
    assert.equal(expandPath("$NOT_SET/x", s.env), "$NOT_SET/x", "unknown vars are left alone");
  });
});

describe("loading profiles", () => {
  it("applies defaults and records the source file", () => {
    const s = sandbox();
    const path = s.write("work/.mikrotik-mcp.json", {
      defaults: { username: "admin+ct", timeoutMs: 5000 },
      profiles: {
        core: { host: "10.0.0.1", tags: ["site-a"], description: "Core router" },
        edge: { host: "10.0.0.2", port: 2222, username: "netops", readOnly: false },
      },
    });

    const loaded = loadConfig(s.env);
    assert.deepEqual(loaded.issues, []);
    assert.deepEqual(loaded.sources, [path]);

    const core = loaded.profiles.get("core");
    assert.ok(core);
    assert.equal(core.port, 22, "port falls back to the built-in default");
    assert.equal(core.username, "admin+ct", "username comes from file defaults");
    assert.equal(core.timeoutMs, 5000);
    assert.equal(core.readOnly, true, "profiles are read-only unless told otherwise");
    assert.equal(core.auth.type, "agent");
    assert.equal(core.hostKey.policy, "known-hosts");
    assert.equal(core.source, path);

    const edge = loaded.profiles.get("edge");
    assert.ok(edge);
    assert.equal(edge.port, 2222, "profile overrides defaults");
    assert.equal(edge.username, "netops");
    assert.equal(edge.readOnly, false);
  });

  it("merges files, with earlier paths winning on name collisions", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", { profiles: { shared: { host: "project" } } });
    s.write("home/.mikrotik-mcp.json", {
      profiles: { shared: { host: "global" }, "global-only": { host: "10.9.9.9" } },
    });

    const loaded = loadConfig(s.env);
    assert.equal(loaded.profiles.get("shared")?.host, "project", "project config wins");
    assert.equal(loaded.profiles.get("global-only")?.host, "10.9.9.9", "other profiles still merge in");
    assert.equal(loaded.sources.length, 2);
  });

  it("defaults the host key policy to pinned when a fingerprint is given", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", {
      profiles: { core: { host: "10.0.0.1", hostKey: { fingerprintSha256: "SHA256:abc" } } },
    });
    assert.equal(loadConfig(s.env).profiles.get("core")?.hostKey.policy, "pinned");
  });

  it("reports a bad file without discarding the good ones", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", "{ not json");
    s.write("home/.mikrotik-mcp.json", { profiles: { good: { host: "10.0.0.5" } } });

    const loaded = loadConfig(s.env);
    assert.equal(loaded.issues.length, 1);
    assert.match(loaded.issues[0]!.message, /not valid JSON/);
    assert.ok(loaded.profiles.has("good"));
  });

  it("rejects unknown keys and bad values", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", { profiles: { core: { host: "10.0.0.1", porrt: 22 } } });
    const loaded = loadConfig(s.env);
    assert.equal(loaded.profiles.size, 0);
    assert.equal(loaded.issues.length, 1);
    assert.match(loaded.issues[0]!.message, /porrt/);
  });

  it("flags a missing file that was named explicitly", () => {
    const s = sandbox();
    s.env.env["MIKROTIK_MCP_CONFIG"] = join(s.dir, "nope.json");
    const loaded = loadConfig(s.env);
    assert.equal(loaded.issues.length, 1);
    assert.match(loaded.issues[0]!.message, /does not exist/);
  });

  it("does not cache between calls", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", { profiles: { a: { host: "1.1.1.1" } } });
    assert.equal(loadConfig(s.env).profiles.size, 1);

    s.write("work/.mikrotik-mcp.json", { profiles: { a: { host: "1.1.1.1" }, b: { host: "2.2.2.2" } } });
    assert.equal(loadConfig(s.env).profiles.size, 2, "edits are picked up without a restart");
  });

  it("names the known profiles when one is missing", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", { profiles: { core: { host: "10.0.0.1" } } });
    assert.throws(
      () => requireProfile("edge", s.env),
      (error: unknown) => error instanceof ProfileNotFoundError && /Known profiles: core/.test(error.message),
    );
  });
});

describe("profile search", () => {
  const s = sandbox();
  s.write("work/.mikrotik-mcp.json", {
    profiles: {
      "core-1": { host: "10.0.0.1", tags: ["core", "site-a"], description: "Main uplink" },
      "branch-1": { host: "192.168.50.1", tags: ["branch", "site-b"] },
    },
  });
  const loaded = loadConfig(s.env);
  const names = (query?: string) => searchProfiles(loaded, query).map((p) => p.name);

  it("lists everything, sorted, when no query is given", () => {
    assert.deepEqual(names(), ["branch-1", "core-1"]);
  });

  it("matches on name, host, tag and description", () => {
    assert.deepEqual(names("core"), ["core-1"]);
    assert.deepEqual(names("192.168"), ["branch-1"]);
    assert.deepEqual(names("SITE-B"), ["branch-1"]);
    assert.deepEqual(names("uplink"), ["core-1"]);
    assert.deepEqual(names("nothing"), []);
  });
});
