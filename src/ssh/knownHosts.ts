import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface KnownHostEntry {
  patterns: string[];
  keyType: string;
  /** base64 of the raw public key blob */
  key: string;
}

/** OpenSSH-style fingerprint of a raw public key blob. */
export function sha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Read the key type out of an SSH wire-format public key blob. */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length <= 0 || length > key.length - 4) return "unknown";
  return key.subarray(4, 4 + length).toString("ascii");
}

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let fields = line.split(/\s+/);
    // Skip markers such as @cert-authority and @revoked; we only trust plain entries.
    if (fields[0]?.startsWith("@")) {
      if (fields[0] !== "@revoked") continue;
      fields = fields.slice(1);
    }
    const [hosts, keyType, key] = fields;
    if (!hosts || !keyType || !key) continue;
    entries.push({ patterns: hosts.split(","), keyType, key });
  }
  return entries;
}

function matchesPattern(pattern: string, candidate: string): boolean {
  if (pattern.startsWith("|1|")) {
    // Hashed host: |1|<base64 salt>|<base64 HMAC-SHA1(salt, host)>
    const [, , salt, hash] = pattern.split("|");
    if (!salt || !hash) return false;
    const actual = createHmac("sha1", Buffer.from(salt, "base64")).update(candidate).digest();
    const expected = Buffer.from(hash, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  if (pattern.includes("*") || pattern.includes("?")) {
    const body = Array.from(pattern, (ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return /[A-Za-z0-9]/.test(ch) ? ch : "\\" + ch;
    }).join("");
    return new RegExp("^" + body + "$", "i").test(candidate);
  }
  return pattern.toLowerCase() === candidate.toLowerCase();
}

export type HostKeyVerdict = "match" | "mismatch" | "unknown";

/**
 * Compare a presented host key against known_hosts entries.
 *
 * 'mismatch' means the host is known and presented a different key — that is a
 * hard failure, not something to fall back from.
 */
export function checkKnownHosts(
  entries: KnownHostEntry[],
  host: string,
  port: number,
  presentedKey: Buffer,
): HostKeyVerdict {
  const candidates = port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];
  const keyType = keyTypeOf(presentedKey);
  const presented = presentedKey.toString("base64");

  let sawHost = false;
  for (const entry of entries) {
    const negated = entry.patterns.some((p) => p.startsWith("!") && candidates.some((c) => matchesPattern(p.slice(1), c)));
    if (negated) continue;
    const hit = entry.patterns.some((p) => !p.startsWith("!") && candidates.some((c) => matchesPattern(p, c)));
    if (!hit) continue;
    sawHost = true;
    if (entry.keyType === keyType && entry.key === presented) return "match";
  }
  return sawHost ? "mismatch" : "unknown";
}

export function loadKnownHosts(path: string): KnownHostEntry[] {
  try {
    return parseKnownHosts(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
