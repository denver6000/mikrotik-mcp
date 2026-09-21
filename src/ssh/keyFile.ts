import { readFileSync, statSync } from "node:fs";
import ssh2 from "ssh2";
import { resolveUserPath, type LookupEnvironment } from "../config/paths.ts";
import type { ResolvedProfile } from "../config/schema.ts";
import { sha256Fingerprint } from "./knownHosts.ts";

const { parseKey } = ssh2.utils;

export interface KeyFileReport {
  /** Absolute path the profile's key setting resolved to. */
  path: string;
  exists: boolean;
  /** 'ssh-ed25519', 'ssh-rsa', … when the key could be parsed. */
  keyType?: string;
  fingerprint?: string;
  encrypted?: boolean;
  /** Set when the key could not be read or parsed. */
  problem?: string;
  /** Set on POSIX systems when the key is readable by group or others. */
  permissionWarning?: string;
}

/**
 * Inspect a private key file without connecting anywhere.
 *
 * This turns the two most common first-run failures — an unreadable or
 * unsupported key, and an encrypted key with nowhere to get its passphrase —
 * into something `--check-config` can state plainly.
 */
export function inspectKeyFile(
  profile: ResolvedProfile,
  e: LookupEnvironment,
): KeyFileReport | null {
  if (profile.auth?.type !== "key") return null;
  const path = resolveUserPath(profile.auth.path, profile.source, e);

  let contents: Buffer;
  try {
    contents = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      path,
      exists: code !== "ENOENT",
      problem:
        code === "ENOENT" ? "no such file" : `cannot be read: ${(error as Error).message}`,
    };
  }

  const report: KeyFileReport = { path, exists: true };

  // Windows does not use POSIX mode bits, so the check would be meaningless there.
  if (e.platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) {
        report.permissionWarning = `mode ${mode.toString(8).padStart(3, "0")} — readable by group or others; chmod 600 it`;
      }
    } catch {
      // A key we just read but cannot stat is not worth failing over.
    }
  }

  const passphrase = profile.auth.passphraseEnv ? e.env[profile.auth.passphraseEnv] : undefined;
  const parsed = parseKey(contents, passphrase);

  if (parsed instanceof Error) {
    const encrypted = /encrypted/i.test(parsed.message);
    report.encrypted = encrypted;
    if (encrypted) {
      report.problem = profile.auth.passphraseEnv
        ? `encrypted, and $${profile.auth.passphraseEnv} ${
            passphrase ? "did not decrypt it" : "is not set"
          }`
        : 'encrypted, but no "passphraseEnv" is set on the profile';
    } else if (/unsupported key format/i.test(parsed.message)) {
      // PKCS#8 PEM is the usual culprit; the OpenSSH format always works.
      report.problem =
        "unsupported key format (PKCS#8 PEM is not supported). Convert it with: " +
        "ssh-keygen -p -m RFC4716 -f <key>, or generate a new one with ssh-keygen -t ed25519";
    } else {
      report.problem = parsed.message;
    }
    return report;
  }

  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) {
    report.problem = "the file contains no usable key";
    return report;
  }

  report.keyType = key.type;
  report.encrypted = false;
  report.fingerprint = sha256Fingerprint(key.getPublicSSH());
  return report;
}
