/**
 * Best-effort classification of RouterOS commands as read-only.
 *
 * This is a guardrail against an agent accidentally reconfiguring or rebooting
 * a router — it is NOT a security boundary. Anything relying on real
 * enforcement should log in as a RouterOS user whose group grants read access
 * only; the router is the only thing that can actually enforce that.
 *
 * The classifier is deliberately conservative: a command is read-only only if
 * it contains a recognised read action and no recognised write action.
 * Anything it does not understand is treated as a write.
 */
const READ_ACTIONS = new Set([
  "print",
  "get",
  "find",
  "export",
  "monitor",
  "monitor-traffic",
  "ping",
  "traceroute",
  "resolve",
  "environment",
  "info",
]);

const WRITE_ACTIONS = new Set([
  "set",
  "add",
  "remove",
  "unset",
  "reset",
  "reset-configuration",
  "reset-counters",
  "move",
  "enable",
  "disable",
  "edit",
  "import",
  "fetch",
  "delete",
  "kill",
  "reboot",
  "shutdown",
  "upgrade",
  "downgrade",
  "install",
  "uninstall",
  "run",
  "start",
  "stop",
  "restart",
  "clear",
  "flush",
  "save",
  "load",
  "backup",
  "restore",
  "generate",
  "issue",
  "revoke",
  "sign",
  "make-binding",
  "release",
  "renew",
  "beep",
  "blink",
  "scan",
  "sniff",
  "torch",
]);

/** Split a command line into the individual commands RouterOS would run. */
export function splitCommands(command: string): string[] {
  return command
    .split(/[;\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  return segment
    .split(/[\s=]+/)
    .map((token) => token.replace(/^\/+/, "").toLowerCase())
    .filter(Boolean);
}

export interface PolicyVerdict {
  readOnly: boolean;
  /** The command that failed the check, when readOnly is false. */
  offending?: string;
  reason?: string;
}

export function classifyCommand(command: string): PolicyVerdict {
  const segments = splitCommands(command);
  if (segments.length === 0) return { readOnly: false, reason: "the command is empty" };

  for (const segment of segments) {
    const tokens = tokenize(segment);
    const write = tokens.find((t) => WRITE_ACTIONS.has(t));
    if (write) {
      return { readOnly: false, offending: segment, reason: `'${write}' modifies the router` };
    }
    if (!tokens.some((t) => READ_ACTIONS.has(t))) {
      return {
        readOnly: false,
        offending: segment,
        reason: "no read-only action (print, get, find, export, monitor, ...) was recognised",
      };
    }
  }
  return { readOnly: true };
}
