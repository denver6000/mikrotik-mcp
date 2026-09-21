import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand, splitCommands } from "../src/ssh/policy.ts";

const readOnly = (command: string) => classifyCommand(command).readOnly;

describe("read-only command policy", () => {
  it("allows ordinary read commands", () => {
    for (const command of [
      "/system resource print",
      "/interface print detail",
      "/ip address print",
      "/ip firewall filter print where chain=input",
      "/export",
      "/system routerboard print",
      "/interface monitor-traffic ether1 once",
      "/ping 1.1.1.1 count=1",
    ]) {
      assert.equal(readOnly(command), true, command);
    }
  });

  it("refuses commands that change the router", () => {
    for (const command of [
      "/system reboot",
      "/system shutdown",
      "/ip address add address=10.0.0.1/24 interface=ether1",
      "/interface set ether1 disabled=yes",
      "/ip firewall filter remove 0",
      "/system reset-configuration",
      "/user add name=evil password=evil group=full",
      "/system package update install",
    ]) {
      assert.equal(readOnly(command), false, command);
    }
  });

  it("treats unrecognised commands as writes", () => {
    assert.equal(readOnly("/some/future/thing do-something"), false);
    assert.equal(readOnly(""), false);
  });

  it("checks every command in a chain, so a read cannot smuggle in a write", () => {
    const verdict = classifyCommand("/system resource print; /system reboot");
    assert.equal(verdict.readOnly, false);
    assert.equal(verdict.offending, "/system reboot");
  });

  it("checks commands separated by newlines too", () => {
    assert.equal(readOnly("/system resource print\n/ip address add address=1.1.1.1/32"), false);
  });

  it("does not confuse path words with action words", () => {
    // 'address-list' contains 'add', 'settings' contains 'set'.
    assert.equal(readOnly("/ip firewall address-list print"), true);
    assert.equal(readOnly("/system routerboard settings print"), true);
  });

  it("splits command chains", () => {
    assert.deepEqual(splitCommands(" /a print ; /b print \n\n /c print "), [
      "/a print",
      "/b print",
      "/c print",
    ]);
  });
});
