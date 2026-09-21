import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import type { ResolvedProfile } from "../config/schema.ts";
import { currentEnvironment, expandPath, type LookupEnvironment } from "../config/paths.ts";
import { checkKnownHosts, loadKnownHosts, sha256Fingerprint } from "./knownHosts.ts";

export class SshError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SshError";
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** null when the router closed the channel without reporting a status. */
  exitCode: number | null;
  exitSignal: string | null;
  durationMs: number;
  /** Fingerprint of the host key the router presented. */
  hostKeyFingerprint: string;
}

const MAX_OUTPUT_BYTES = 1_000_000;

function defaultAgentSocket(e: LookupEnvironment): string | undefined {
  const fromEnv = e.env["SSH_AUTH_SOCK"];
  if (fromEnv) return fromEnv;
  return e.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined;
}

function requireEnv(name: string, e: LookupEnvironment, purpose: string): string {
  const value = e.env[name];
  if (!value) {
    throw new SshError(
      `Environment variable ${name} is not set; it must hold the ${purpose} for this profile.`,
    );
  }
  return value;
}

function authConfig(profile: ResolvedProfile, e: LookupEnvironment): ConnectConfig {
  switch (profile.auth.type) {
    case "agent": {
      const agent = profile.auth.socket ? expandPath(profile.auth.socket, e) : defaultAgentSocket(e);
      if (!agent) {
        throw new SshError(
          `Profile '${profile.name}' uses SSH agent auth but no agent is available (SSH_AUTH_SOCK is unset).`,
        );
      }
      return { agent };
    }
    case "key": {
      const path = expandPath(profile.auth.path, e);
      let privateKey: Buffer;
      try {
        privateKey = readFileSync(path);
      } catch (error) {
        throw new SshError(`Cannot read private key '${path}': ${(error as Error).message}`, error);
      }
      const passphraseEnv = profile.auth.passphraseEnv;
      return {
        privateKey,
        ...(passphraseEnv ? { passphrase: requireEnv(passphraseEnv, e, "key passphrase") } : {}),
      };
    }
    case "password": {
      // RouterOS may offer keyboard-interactive instead of, or as well as,
      // plain password auth. Enable both and answer the prompts with the same
      // secret; see the 'keyboard-interactive' handler in execCommand.
      return {
        password: requireEnv(profile.auth.passwordEnv, e, "password"),
        tryKeyboard: true,
      };
    }
  }
}

interface HostKeyOutcome {
  accepted: boolean;
  fingerprint: string;
  reason?: string;
}

/**
 * Decide whether to trust the key a router presented.
 *
 * Note for maintainers: ssh2 treats ANY truthy return from its hostVerifier as
 * acceptance, so this must return a strict boolean — returning an Error would
 * silently accept the key. The reason is reported separately.
 */
function verifyHostKey(
  profile: ResolvedProfile,
  e: LookupEnvironment,
  key: Buffer,
): HostKeyOutcome {
  const fingerprint = sha256Fingerprint(key);
  const deny = (reason: string): HostKeyOutcome => ({ accepted: false, fingerprint, reason });

  switch (profile.hostKey.policy) {
    case "insecure-ignore":
      return { accepted: true, fingerprint };

    case "pinned": {
      const expected = profile.hostKey.fingerprintSha256;
      if (!expected) {
        return deny(
          `Profile '${profile.name}' uses the 'pinned' host key policy but sets no fingerprintSha256. The router presented ${fingerprint}.`,
        );
      }
      const normalise = (f: string) => f.replace(/^SHA256:/i, "").replace(/=+$/, "");
      return normalise(expected) === normalise(fingerprint)
        ? { accepted: true, fingerprint }
        : deny(`Host key mismatch for ${profile.host}: expected ${expected}, got ${fingerprint}.`);
    }

    case "known-hosts": {
      const path = profile.hostKey.knownHostsPath
        ? expandPath(profile.hostKey.knownHostsPath, e)
        : join(e.home, ".ssh", "known_hosts");
      const verdict = checkKnownHosts(loadKnownHosts(path), profile.host, profile.port, key);
      if (verdict === "match") return { accepted: true, fingerprint };
      if (verdict === "mismatch") {
        return deny(
          `HOST KEY CHANGED for ${profile.host}: the router presented ${fingerprint}, which does not match ${path}. This may be a man-in-the-middle attack. Verify the router, then update known_hosts.`,
        );
      }
      return deny(
        `Host key for ${profile.host} is not in ${path} (fingerprint ${fingerprint}). Verify it out of band, then either add it to known_hosts or set "hostKey": { "policy": "pinned", "fingerprintSha256": "${fingerprint}" } on profile '${profile.name}'.`,
      );
    }
  }
}

/**
 * Run one command on one router and return.
 *
 * Every call opens its own connection and closes it before resolving — no
 * pooling, no sessions, no state kept between calls.
 */
export function execCommand(
  profile: ResolvedProfile,
  command: string,
  e: LookupEnvironment = currentEnvironment(),
  timeoutMs: number = profile.timeoutMs,
): Promise<ExecResult> {
  const started = Date.now();

  return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
    const conn = new Client();
    let hostKeyFingerprint = "";
    let hostKeyRejection: string | null = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let truncated = false;

    const finish = (error: Error | null, result?: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
        conn.destroy();
      } catch {
        // the connection is going away regardless
      }
      if (error) rejectPromise(error);
      else resolvePromise(result as ExecResult);
    };

    const timer = setTimeout(() => {
      finish(
        new SshError(
          `Timed out after ${timeoutMs}ms running on '${profile.name}' (${profile.host}:${profile.port}).`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    const append = (target: "out" | "err", chunk: Buffer): void => {
      if (stdout.length + stderr.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      if (target === "out") stdout += text;
      else stderr += text;
    };

    if (profile.auth.type === "password") {
      const password = e.env[profile.auth.passwordEnv] ?? "";
      conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, submit) => {
        submit(prompts.map(() => password));
      });
    }

    conn.on("ready", () => {
      conn.exec(command, (error, stream) => {
        if (error) {
          finish(new SshError(`Failed to start command on '${profile.name}': ${error.message}`, error));
          return;
        }
        let exitCode: number | null = null;
        let exitSignal: string | null = null;

        stream
          .on("exit", (code: number | null, signal?: string) => {
            exitCode = typeof code === "number" ? code : null;
            exitSignal = signal ?? null;
          })
          .on("close", () => {
            if (truncated) {
              stdout += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
            }
            finish(null, {
              stdout,
              stderr,
              exitCode,
              exitSignal,
              durationMs: Date.now() - started,
              hostKeyFingerprint,
            });
          })
          .on("data", (chunk: Buffer) => append("out", chunk));
        stream.stderr.on("data", (chunk: Buffer) => append("err", chunk));
      });
    });

    conn.on("error", (error: Error & { level?: string }) => {
      // A rejected host key surfaces here as a generic handshake error; report
      // the specific reason instead.
      if (hostKeyRejection) {
        finish(new SshError(hostKeyRejection, error));
        return;
      }
      const where = `${profile.host}:${profile.port}`;
      const detail = error.level ? `${error.level}: ${error.message}` : error.message;
      finish(new SshError(`SSH connection to '${profile.name}' (${where}) failed — ${detail}`, error));
    });

    try {
      conn.connect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        readyTimeout: timeoutMs,
        keepaliveInterval: 0,
        ...(profile.algorithms ? { algorithms: profile.algorithms as ConnectConfig["algorithms"] } : {}),
        hostVerifier: (key: Buffer): boolean => {
          const outcome = verifyHostKey(profile, e, key);
          hostKeyFingerprint = outcome.fingerprint;
          if (!outcome.accepted) hostKeyRejection = outcome.reason ?? "Host key rejected.";
          return outcome.accepted;
        },
        ...authConfig(profile, e),
      });
    } catch (error) {
      if (error instanceof SshError) finish(error);
      else finish(new SshError(`Cannot connect to '${profile.name}': ${(error as Error).message}`, error));
    }
  });
}
