import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
// ssh2 is CommonJS and Node only detects some of its named exports, so take Server
// off the default export.
import ssh2, { type Connection } from "ssh2";

const { Server } = ssh2;
import { execCommand, SshError } from "../src/ssh/exec.ts";
import type { ResolvedProfile } from "../src/config/schema.ts";
import { sandbox } from "./helpers.ts";

/**
 * A stand-in for a RouterOS box: accepts one password, echoes the command it
 * was asked to run, and exits with a code derived from that command.
 */
function startFakeRouter(hostKey: string, mode: "password" | "keyboard-interactive" = "password") {
  const connections: Connection[] = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    connections.push(client);
    client
      .on("authentication", (ctx) => {
        if (ctx.username !== "admin") {
          ctx.reject();
          return;
        }
        if (mode === "keyboard-interactive") {
          // Refuse plain password auth outright, as a router configured for
          // keyboard-interactive would.
          if (ctx.method === "keyboard-interactive") {
            ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
              if (answers[0] === "s3cret") ctx.accept();
              else ctx.reject();
            });
            return;
          }
          ctx.reject(["keyboard-interactive"]);
          return;
        }
        if (ctx.method === "password" && ctx.password === "s3cret") ctx.accept();
        else if (ctx.method === "none") ctx.reject(["password"]);
        else ctx.reject();
      })
      .on("ready", () => {
        client.on("session", (acceptSession) => {
          acceptSession().on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            if (info.command.includes("boom")) {
              stream.stderr.write("failure: no such item\n");
              stream.exit(1);
            } else {
              stream.write(`ran: ${info.command}\n`);
              stream.exit(0);
            }
            stream.end();
          });
        });
      })
      .on("error", () => {
        // A client hanging up mid-handshake is expected in these tests.
      });
  });

  return {
    server,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) c.end();
        server.close(() => resolve());
      }),
  };
}

const { privateKey: hostKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const router = startFakeRouter(hostKeyPem);
let port = 0;
const s = sandbox({ MTK_PW: "s3cret" });

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "test",
    host: "127.0.0.1",
    port,
    username: "admin",
    auth: { type: "password", passwordEnv: "MTK_PW" },
    hostKey: { policy: "insecure-ignore" },
    readOnly: true,
    timeoutMs: 10_000,
    tags: [],
    source: "(test)",
    ...overrides,
  };
}

describe("execCommand against a live SSH server", () => {
  before(async () => {
    port = await router.listen();
  });
  after(async () => {
    await router.close();
  });

  it("runs a command and returns its output", async () => {
    const result = await execCommand(profile(), "/system resource print", s.env);
    assert.equal(result.stdout.trim(), "ran: /system resource print");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.match(result.hostKeyFingerprint, /^SHA256:/);
    assert.ok(result.durationMs >= 0);
  });

  it("surfaces stderr and a non-zero exit code", async () => {
    const result = await execCommand(profile(), "boom", s.env);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no such item/);
  });

  it("opens a new connection per call and leaves nothing behind", async () => {
    const first = await execCommand(profile(), "/one print", s.env);
    const second = await execCommand(profile(), "/two print", s.env);
    assert.equal(first.stdout.trim(), "ran: /one print");
    assert.equal(second.stdout.trim(), "ran: /two print", "no state carries over between calls");
  });

  it("accepts a host key that matches the pinned fingerprint", async () => {
    const probe = await execCommand(profile(), "/probe print", s.env);
    const pinned = profile({
      hostKey: { policy: "pinned", fingerprintSha256: probe.hostKeyFingerprint },
    });
    const result = await execCommand(pinned, "/system resource print", s.env);
    assert.equal(result.exitCode, 0);
  });

  it("refuses a host key that does not match the pinned fingerprint", async () => {
    const pinned = profile({
      hostKey: { policy: "pinned", fingerprintSha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    await assert.rejects(execCommand(pinned, "/system resource print", s.env), (error: unknown) => {
      assert.ok(error instanceof SshError);
      assert.match(error.message, /Host key mismatch/);
      return true;
    });
  });

  it("refuses an unknown host under the known-hosts policy", async () => {
    const strict = profile({ hostKey: { policy: "known-hosts" } });
    await assert.rejects(execCommand(strict, "/system resource print", s.env), (error: unknown) => {
      assert.ok(error instanceof SshError);
      assert.match(error.message, /is not in .*known_hosts/);
      assert.match(error.message, /fingerprint SHA256:/, "the fingerprint is shown so it can be pinned");
      return true;
    });
  });

  it("fails clearly when the password environment variable is unset", async () => {
    const empty = sandbox();
    await assert.rejects(execCommand(profile(), "/system resource print", empty.env), (error: unknown) => {
      assert.ok(error instanceof SshError);
      assert.match(error.message, /MTK_PW is not set/);
      return true;
    });
  });

  it("reports a wrong password as an authentication failure", async () => {
    const wrong = sandbox({ MTK_PW: "nope" });
    await assert.rejects(execCommand(profile(), "/system resource print", wrong.env), (error: unknown) => {
      assert.ok(error instanceof SshError);
      assert.match(error.message, /failed/i);
      return true;
    });
  });

  it("times out instead of hanging", async () => {
    // Port 1 on loopback has nothing listening, so the connect attempt stalls or refuses.
    const dead = profile({ host: "127.0.0.1", port: 1, timeoutMs: 1500 });
    await assert.rejects(execCommand(dead, "/system resource print", s.env), (error: unknown) => {
      assert.ok(error instanceof SshError);
      return true;
    });
  });
});

describe("a router that only offers keyboard-interactive auth", () => {
  const kbRouter = startFakeRouter(hostKeyPem, "keyboard-interactive");
  let kbPort = 0;

  before(async () => {
    kbPort = await kbRouter.listen();
  });
  after(async () => {
    await kbRouter.close();
  });

  it("authenticates by answering the prompt with the same secret", async () => {
    const result = await execCommand(profile({ port: kbPort }), "/system identity print", s.env);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "ran: /system identity print");
  });

  it("still fails when the secret is wrong", async () => {
    const wrong = sandbox({ MTK_PW: "nope" });
    await assert.rejects(execCommand(profile({ port: kbPort }), "/x print", wrong.env));
  });
});
