/**
 * Emit a JSON Schema for the config file, so editors can offer completion and
 * validation via the "$schema" key. Run with `npm run schema`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigSchema } from "../src/config/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "schema", "mikrotik-mcp.schema.json");

const schema = {
  $id: "https://raw.githubusercontent.com/denver6000/mikrotik-mcp/main/schema/mikrotik-mcp.schema.json",
  title: "mikrotik-mcp configuration",
  ...z.toJSONSchema(ConfigSchema, { io: "input" }),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);
