import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentEnvironment, type LookupEnvironment } from "./config/paths.ts";
import { registerExecTool } from "./tools/exec.ts";
import { registerListProfilesTool } from "./tools/listProfiles.ts";

export const SERVER_NAME = "mikrotik-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a server instance with every tool registered.
 *
 * The server holds no state of its own: config is re-read and SSH connections
 * are opened and closed inside each tool call. `e` is injectable so tests can
 * point the config search at a temporary directory.
 */
export function createServer(e: LookupEnvironment = currentEnvironment()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Runs RouterOS commands on MikroTik routers over SSH. Call mikrotik_list_profiles to see " +
        "which routers are configured, then mikrotik_exec to run a command on one. Each call is " +
        "independent — a fresh SSH connection is opened and closed, so no shell state persists.",
    },
  );

  registerListProfilesTool(server, e);
  registerExecTool(server, e);

  return server;
}
