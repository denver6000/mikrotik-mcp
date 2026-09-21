import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { checkKnownHosts, keyTypeOf, parseKnownHosts, sha256Fingerprint } from "../src/ssh/knownHosts.ts";

/** Build an SSH wire-format public key blob: length-prefixed type, then body. */
function fakeKey(type: string, body: string): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(typeBuf.length, 0);
  return Buffer.concat([length, typeBuf, Buffer.from(body, "utf8")]);
}

const key = fakeKey("ssh-ed25519", "router-key");
const other = fakeKey("ssh-ed25519", "different-key");
const line = (host: string, k: Buffer) => `${host} ssh-ed25519 ${k.toString("base64")}`;

describe("known_hosts", () => {
  it("reads the key type out of a key blob", () => {
    assert.equal(keyTypeOf(key), "ssh-ed25519");
    assert.equal(keyTypeOf(Buffer.alloc(2)), "unknown");
  });

  it("formats an OpenSSH-style fingerprint", () => {
    const fingerprint = sha256Fingerprint(key);
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.ok(!fingerprint.endsWith("="), "padding is stripped, as ssh-keygen does");
  });

  it("skips comments, blanks and @cert-authority lines", () => {
    const entries = parseKnownHosts(
      ["# a comment", "", `@cert-authority *.example.com ssh-rsa AAAA`, line("10.0.0.1", key)].join("\n"),
    );
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.patterns, ["10.0.0.1"]);
  });

  it("matches a plain host on the default port", () => {
    const entries = parseKnownHosts(line("10.0.0.1", key));
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 22, key), "match");
  });

  it("requires the bracketed form on a non-default port", () => {
    const entries = parseKnownHosts(line("[10.0.0.1]:2222", key));
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 2222, key), "match");
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 22, key), "unknown");
  });

  it("matches comma-separated host lists and wildcards", () => {
    const entries = parseKnownHosts(line("router.lan,10.0.0.1", key));
    assert.equal(checkKnownHosts(entries, "router.lan", 22, key), "match");
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 22, key), "match");
    assert.equal(checkKnownHosts(parseKnownHosts(line("*.lan", key)), "router.lan", 22, key), "match");
  });

  it("matches hashed host entries", () => {
    const salt = randomBytes(20);
    const hash = createHmac("sha1", salt).update("10.0.0.1").digest("base64");
    const hashed = `|1|${salt.toString("base64")}|${hash}`;
    const entries = parseKnownHosts(line(hashed, key));
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 22, key), "match");
    assert.equal(checkKnownHosts(entries, "10.0.0.2", 22, key), "unknown");
  });

  it("reports a mismatch when a known host presents a different key", () => {
    const entries = parseKnownHosts(line("10.0.0.1", key));
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 22, other), "mismatch");
  });

  it("reports unknown for a host that is absent", () => {
    assert.equal(checkKnownHosts([], "10.0.0.1", 22, key), "unknown");
  });

  it("honours negated patterns", () => {
    const entries = parseKnownHosts(`!10.0.0.1,*.lan ssh-ed25519 ${key.toString("base64")}`);
    assert.equal(checkKnownHosts(entries, "10.0.0.1", 22, key), "unknown");
  });
});
