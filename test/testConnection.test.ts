import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import ssh2 from "ssh2";
import { testConnection } from "../src/ssh/testConnection.ts";
import { sandbox } from "./helpers.ts";

const { Server } = ssh2;

const { privateKey: hostKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const server = new Server({ hostKeys: [hostKeyPem] }, (client) => {
  client
    .on("authentication", (ctx) => (ctx.method === "password" ? ctx.accept() : ctx.reject(["password"])))
    .on("ready", () => {
      client.on("session", (acceptSession) => {
        acceptSession().on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.write("  name: MikroTik-core\n");
          stream.exit(0);
          stream.end();
        });
      });
    })
    .on("error", () => {});
});

describe("--test <profile>", () => {
  let port = 0;

  before(async () => {
    port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function configured() {
    const s = sandbox({ MTK_PW: "s3cret" });
    s.write("work/.mikrotik-mcp.json", {
      profiles: {
        core: {
          host: "127.0.0.1",
          port,
          auth: { type: "password", passwordEnv: "MTK_PW" },
          hostKey: { policy: "insecure-ignore" },
        },
        unreachable: {
          host: "127.0.0.1",
          port: 1,
          timeoutMs: 1500,
          auth: { type: "password", passwordEnv: "MTK_PW" },
          hostKey: { policy: "insecure-ignore" },
        },
      },
    });
    return s;
  }

  it("connects, runs the probe and reports the router's answer", async () => {
    const result = await testConnection("core", configured().env);
    assert.equal(result.ok, true);
    assert.match(result.text, /Connecting to 'core' \(admin@127\.0\.0\.1:\d+\) as password/);
    assert.match(result.text, /host key\s+SHA256:/);
    assert.match(result.text, /exit code\s+0/);
    assert.match(result.text, /name: MikroTik-core/);
    assert.match(result.text, /OK\./);
  });

  it("reports a failure instead of throwing", async () => {
    const result = await testConnection("unreachable", configured().env);
    assert.equal(result.ok, false);
    assert.match(result.text, /FAILED\./);
  });

  it("names the known profiles when asked for one that does not exist", async () => {
    const result = await testConnection("typo", configured().env);
    assert.equal(result.ok, false);
    assert.match(result.text, /Known profiles: core, unreachable/);
  });

  it("does not print the password", async () => {
    const result = await testConnection("core", configured().env);
    assert.ok(!result.text.includes("s3cret"));
  });
});
