import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeConfig } from "../src/config/report.ts";
import { sandbox } from "./helpers.ts";

describe("--check-config report", () => {
  it("marks which files loaded and lists each profile", () => {
    const s = sandbox({ MTK_PW: "s3cret" });
    const path = s.write("work/.mikrotik-mcp.json", {
      profiles: {
        core: { host: "10.0.0.1" },
        lab: { host: "10.0.0.9", readOnly: false, auth: { type: "password", passwordEnv: "MTK_PW" } },
      },
    });

    const report = describeConfig(s.env);
    assert.equal(report.ok, true);
    assert.match(report.text, new RegExp(`loaded\\s+${path.replace(/[\\.]/g, "\\$&")}`));
    assert.match(report.text, /core\n\s+ssh\s+admin@10\.0\.0\.1:22/);
    assert.match(report.text, /writes\s+refused \(readOnly\)/);
    assert.match(report.text, /writes\s+ALLOWED/);
    assert.ok(!report.text.includes("s3cret"), "the password value must not be printed");
  });

  it("says when a password variable the config depends on is missing", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", {
      profiles: { lab: { host: "10.0.0.9", auth: { type: "password", passwordEnv: "MTK_PW" } } },
    });
    assert.match(describeConfig(s.env).text, /\$MTK_PW — NOT SET/);
  });

  it("fails when a config file is broken", () => {
    const s = sandbox();
    s.write("work/.mikrotik-mcp.json", "{ oops");
    const report = describeConfig(s.env);
    assert.equal(report.ok, false);
    assert.match(report.text, /FAILED/);
    assert.match(report.text, /not valid JSON/);
  });

  it("fails when nothing is configured, and shows where it looked", () => {
    const s = sandbox();
    const report = describeConfig(s.env);
    assert.equal(report.ok, false);
    assert.match(report.text, /No profiles found/);
    assert.ok(report.text.includes(s.cwd));
  });
});
