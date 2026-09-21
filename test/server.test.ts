import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import type { LookupEnvironment } from "../src/config/paths.ts";
import { sandbox } from "./helpers.ts";

async function connect(e: LookupEnvironment): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([createServer(e).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content;
  return (content ?? []).map((c) => c.text ?? "").join("\n");
}

function configured() {
  const s = sandbox({ MTK_PW: "s3cret" });
  s.write("work/.mikrotik-mcp.json", {
    profiles: {
      core: { host: "10.0.0.1", tags: ["site-a"], description: "Core router" },
      lab: { host: "10.0.0.9", readOnly: false, auth: { type: "password", passwordEnv: "MTK_PW" } },
    },
  });
  return s;
}

describe("tool surface", () => {
  it("exposes the profile, exec and docs tools", async () => {
    const client = await connect(sandbox().env);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["mikrotik_exec", "mikrotik_list_profiles", "mikrotik_search_docs"],
    );
  });

  it("warns in the exec tool description that item numbers are unstable", async () => {
    const client = await connect(sandbox().env);
    const { tools } = await client.listTools();
    const exec = tools.find((t) => t.name === "mikrotik_exec");
    assert.match(exec?.description ?? "", /Item numbers .* NOT stable/);
    assert.match(exec?.description ?? "", /\[find where/);
  });
});

describe("mikrotik_list_profiles", () => {
  it("lists configured profiles with their connection details", async () => {
    const s = configured();
    const client = await connect(s.env);
    const result = await client.callTool({ name: "mikrotik_list_profiles", arguments: {} });

    const text = textOf(result);
    assert.match(text, /core — admin@10\.0\.0\.1:22 \(read-only/);
    assert.match(text, /lab — admin@10\.0\.0\.9:22 \(read-write/);

    const structured = result.structuredContent as { profiles: { name: string }[] };
    assert.deepEqual(structured.profiles.map((p) => p.name), ["core", "lab"]);
  });

  it("filters by query", async () => {
    const client = await connect(configured().env);
    const result = await client.callTool({
      name: "mikrotik_list_profiles",
      arguments: { query: "site-a" },
    });
    const structured = result.structuredContent as { profiles: { name: string }[] };
    assert.deepEqual(structured.profiles.map((p) => p.name), ["core"]);
  });

  it("never reveals secrets, only the variable holding them", async () => {
    const client = await connect(configured().env);
    const result = await client.callTool({ name: "mikrotik_list_profiles", arguments: {} });
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes("s3cret"), "the password value must not leak");
    assert.ok(serialised.includes("MTK_PW"), "the variable name is shown so it can be set");
  });

  it("explains where it looked when nothing is configured", async () => {
    const s = sandbox();
    const client = await connect(s.env);
    const result = await client.callTool({ name: "mikrotik_list_profiles", arguments: {} });
    const text = textOf(result);
    assert.match(text, /No router profiles are configured/);
    assert.ok(text.includes(s.cwd), "the searched paths are listed");
  });

  it("surfaces broken config files", async () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", "{ oops");
    const client = await connect(s.env);
    const text = textOf(await client.callTool({ name: "mikrotik_list_profiles", arguments: {} }));
    assert.match(text, /Config problems:/);
    assert.match(text, /not valid JSON/);
  });
});

describe("mikrotik_exec", () => {
  it("refuses an unknown profile and names the ones that exist", async () => {
    const client = await connect(configured().env);
    const result = await client.callTool({
      name: "mikrotik_exec",
      arguments: { profile: "nope", command: "/system resource print" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown profile 'nope'.*Known profiles: core, lab/s);
  });

  it("blocks a write on a read-only profile before connecting", async () => {
    const client = await connect(configured().env);
    const result = await client.callTool({
      name: "mikrotik_exec",
      arguments: { profile: "core", command: "/system reboot" },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /read-only/);
    assert.match(text, /'reboot' modifies the router/);
    assert.match(text, /"readOnly": false/, "the error says how to allow it");
  });

  it("blocks a write smuggled into a chain of commands", async () => {
    const client = await connect(configured().env);
    const result = await client.callTool({
      name: "mikrotik_exec",
      arguments: { profile: "core", command: "/system resource print; /user add name=x" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /\/user add name=x/);
  });

  it("lets a read-write profile through the policy and fails at the network instead", async () => {
    const client = await connect(configured().env);
    const result = await client.callTool({
      name: "mikrotik_exec",
      // 10.0.0.9 is not reachable from the test run; the point is that the
      // policy did not reject the command.
      arguments: { profile: "lab", command: "/system reboot", timeoutMs: 1500 },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.ok(!text.includes("read-only"), `expected a connection error, got: ${text}`);
    assert.match(text, /SSH connection|Timed out|Cannot connect/);
  });
});
