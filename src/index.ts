#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeConfig } from "./config/report.ts";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";
import { testConnection } from "./ssh/testConnection.ts";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

A Model Context Protocol server that runs RouterOS commands on MikroTik
routers over SSH. It speaks JSON-RPC over stdio and is normally launched by an
MCP client rather than run by hand.

Usage:
  ${SERVER_NAME}                    Start the server on stdio
  ${SERVER_NAME} --check-config     Show which config files load, and what they define
  ${SERVER_NAME} --test <profile>   Connect to one router and run a harmless read
  ${SERVER_NAME} --version          Print the version
  ${SERVER_NAME} --help             Print this help

Client config (Claude Code, Codex, opencode, ...):
  { "command": "npx", "args": ["-y", "${SERVER_NAME}"] }
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (args.includes("--check-config")) {
    const report = describeConfig();
    process.stdout.write(report.text);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const testIndex = args.indexOf("--test");
  if (testIndex !== -1) {
    const name = args[testIndex + 1];
    if (!name || name.startsWith("-")) {
      process.stderr.write(`${SERVER_NAME}: --test needs a profile name\n`);
      process.exitCode = 2;
      return;
    }
    const result = await testConnection(name);
    process.stdout.write(result.text);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the JSON-RPC channel; all diagnostics must go to stderr.
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} listening on stdio\n`);

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME}: fatal: ${String(error)}\n`);
  process.exit(1);
});
