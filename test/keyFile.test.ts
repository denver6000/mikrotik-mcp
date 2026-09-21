import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { describeConfig } from "../src/config/report.ts";
import { inspectKeyFile } from "../src/ssh/keyFile.ts";
import { knownHostsPaths } from "../src/ssh/exec.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

/**
 * PKCS#1 PEM, which ssh2 supports. Note that PKCS#8 PEM — including PKCS#8
 * ed25519 — is NOT supported by ssh2; see the "unsupported format" test.
 */
function rsaKey(passphrase?: string): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: passphrase
      ? { type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase }
      : { type: "pkcs1", format: "pem" },
  }).privateKey;
}

/** PKCS#8 ed25519 — a format ssh2 cannot read. */
function pkcs8Ed25519(): string {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

/** A profile whose key path is written relative to the config file. */
function withKey(s: Sandbox, auth: Record<string, unknown>) {
  s.write("work/.mikrotik-mcp.json", { profiles: { core: { host: "10.0.0.1", auth } } });
  const profile = loadConfig(s.env).profiles.get("core");
  assert.ok(profile);
  return profile;
}

describe("key file inspection", () => {
  it("resolves a relative key path against the config file, not the working directory", () => {
    const s = sandbox();
    s.write("work/keys/router", rsaKey());
    const report = inspectKeyFile(withKey(s, { type: "key", path: "./keys/router" }), s.env);

    assert.ok(report);
    assert.equal(report.path, `${s.cwd}\\keys\\router`.replace(/\\/g, report.path.includes("\\") ? "\\" : "/"));
    assert.equal(report.exists, true);
    assert.equal(report.problem, undefined);
  });

  it("reports the key type and fingerprint of a usable key", () => {
    const s = sandbox();
    s.write("work/keys/router", rsaKey());
    const report = inspectKeyFile(withKey(s, { type: "key", path: "./keys/router" }), s.env);

    assert.equal(report?.keyType, "ssh-rsa");
    assert.match(report?.fingerprint ?? "", /^SHA256:/);
    assert.equal(report?.encrypted, false);
  });

  it("says a key is missing rather than failing at connect time", () => {
    const s = sandbox();
    const report = inspectKeyFile(withKey(s, { type: "key", path: "./keys/absent" }), s.env);
    assert.equal(report?.exists, false);
    assert.equal(report?.problem, "no such file");
  });

  it("detects an encrypted key with no passphraseEnv", () => {
    const s = sandbox();
    s.write("work/keys/locked", rsaKey("hunter2"));
    const report = inspectKeyFile(withKey(s, { type: "key", path: "./keys/locked" }), s.env);

    assert.equal(report?.encrypted, true);
    assert.match(report?.problem ?? "", /no "passphraseEnv" is set/);
  });

  it("accepts an encrypted key when the passphrase variable is set", () => {
    const s = sandbox({ MTK_PASS: "hunter2" });
    s.write("work/keys/locked", rsaKey("hunter2"));
    const report = inspectKeyFile(
      withKey(s, { type: "key", path: "./keys/locked", passphraseEnv: "MTK_PASS" }),
      s.env,
    );

    assert.equal(report?.problem, undefined);
    assert.equal(report?.keyType, "ssh-rsa");
  });

  it("says so when the passphrase variable is not set", () => {
    const s = sandbox();
    s.write("work/keys/locked", rsaKey("hunter2"));
    const report = inspectKeyFile(
      withKey(s, { type: "key", path: "./keys/locked", passphraseEnv: "MTK_PASS" }),
      s.env,
    );
    assert.match(report?.problem ?? "", /\$MTK_PASS is not set/);
  });

  it("reports an unparseable file instead of a generic failure", () => {
    const s = sandbox();
    s.write("work/keys/junk", "this is not a key");
    const report = inspectKeyFile(withKey(s, { type: "key", path: "./keys/junk" }), s.env);
    assert.ok(report?.problem);
    assert.equal(report.keyType, undefined);
  });

  it("explains how to convert a PKCS#8 key, which ssh2 cannot read", () => {
    const s = sandbox();
    s.write("work/keys/pkcs8", pkcs8Ed25519());
    const report = inspectKeyFile(withKey(s, { type: "key", path: "./keys/pkcs8" }), s.env);
    assert.match(report?.problem ?? "", /PKCS#8 PEM is not supported/);
    assert.match(report?.problem ?? "", /ssh-keygen/);
  });

  it("returns nothing for profiles that do not use a key", () => {
    const s = sandbox();
    assert.equal(inspectKeyFile(withKey(s, { type: "agent" }), s.env), null);
  });
});

describe("known_hosts location", () => {
  it("prefers a file beside the config, then the personal one", () => {
    const s = sandbox();
    const profile = withKey(s, { type: "agent" });
    const paths = knownHostsPaths(profile, s.env);

    assert.equal(paths.length, 2);
    assert.ok(paths[0]!.startsWith(s.cwd), "config-adjacent known_hosts comes first");
    assert.ok(paths[1]!.includes(".ssh"), "the personal file is only a fallback");
  });

  it("uses only the explicit path when the profile names one", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", {
      profiles: {
        core: {
          host: "10.0.0.1",
          auth: { type: "agent" },
          hostKey: { policy: "known-hosts", knownHostsPath: "./trust/routers" },
        },
      },
    });
    const profile = loadConfig(s.env).profiles.get("core");
    assert.ok(profile);
    const paths = knownHostsPaths(profile, s.env);

    assert.equal(paths.length, 1, "no fallback to the personal file");
    assert.ok(paths[0]!.startsWith(s.cwd));
  });
});

describe("--check-config with keys", () => {
  it("shows the key type and fails on a key problem", () => {
    const s = sandbox();
    s.write("work/keys/good", rsaKey());
    s.write("work/.mikrotik-mcp.json", {
      profiles: {
        ok: { host: "10.0.0.1", auth: { type: "key", path: "./keys/good" } },
        broken: { host: "10.0.0.2", auth: { type: "key", path: "./keys/missing" } },
      },
    });

    const report = describeConfig(s.env);
    assert.match(report.text, /ssh-rsa, SHA256:/);
    assert.match(report.text, /PROBLEM: no such file/);
    assert.equal(report.ok, false, "a broken key fails the check");
  });

  it("flags a profile with no auth declared", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", { profiles: { core: { host: "10.0.0.1" } } });
    const report = describeConfig(s.env);
    assert.match(report.text, /NONE DECLARED/);
    assert.equal(report.ok, false);
  });

  it("lists the known_hosts files that will be consulted", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", {
      profiles: { core: { host: "10.0.0.1", auth: { type: "agent" } } },
    });
    assert.match(describeConfig(s.env).text, /host key\s+known-hosts: .*known_hosts/);
  });
});
