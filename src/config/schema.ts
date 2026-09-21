import { z } from "zod";

/**
 * How to authenticate to a router.
 *
 * Secrets are never stored in the config file itself — a profile names the
 * environment variable that holds the secret, and the value is read at connect
 * time. That keeps config files safe to commit and share.
 */
export const AuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agent"),
      socket: z
        .string()
        .optional()
        .describe(
          "Override the SSH agent socket. Defaults to $SSH_AUTH_SOCK, or the OpenSSH named pipe on Windows.",
        ),
    })
    .describe("Authenticate with a key held by a running SSH agent."),
  z
    .object({
      type: z.literal("key"),
      path: z
        .string()
        .min(1)
        .describe("Path to a private key. '~' and $VARS are expanded."),
      passphraseEnv: z
        .string()
        .min(1)
        .optional()
        .describe("Environment variable holding the key passphrase, if encrypted."),
    })
    .describe("Authenticate with a private key file."),
  z
    .object({
      type: z.literal("password"),
      passwordEnv: z
        .string()
        .min(1)
        .describe("Environment variable holding the password. Never inline the password."),
    })
    .describe("Authenticate with a password read from the environment."),
]);

export type Auth = z.infer<typeof AuthSchema>;

export const HostKeySchema = z
  .object({
    policy: z
      .enum(["known-hosts", "pinned", "insecure-ignore"])
      .optional()
      .describe(
        "known-hosts: verify against known_hosts (default). pinned: verify against fingerprintSha256. insecure-ignore: accept any key.",
      ),
    knownHostsPath: z
      .string()
      .optional()
      .describe("known_hosts file to check. Defaults to ~/.ssh/known_hosts."),
    fingerprintSha256: z
      .string()
      .optional()
      .describe("Expected host key fingerprint, e.g. 'SHA256:abc...'. Required by the 'pinned' policy."),
  })
  .strict();

export type HostKey = z.infer<typeof HostKeySchema>;

const AlgorithmListSchema = z.union([
  z.array(z.string()),
  z
    .object({
      append: z.array(z.string()).optional(),
      prepend: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    })
    .strict(),
]);

/**
 * SSH algorithm overrides, passed straight to ssh2.
 *
 * Older RouterOS releases (and routers with "strong crypto" disabled) offer
 * key exchange and host key algorithms that modern SSH clients no longer
 * enable by default. Use `append` to add them back for that router only.
 */
export const AlgorithmsSchema = z
  .object({
    kex: AlgorithmListSchema.optional(),
    cipher: AlgorithmListSchema.optional(),
    serverHostKey: AlgorithmListSchema.optional(),
    hmac: AlgorithmListSchema.optional(),
    compress: AlgorithmListSchema.optional(),
  })
  .strict();

export type Algorithms = z.infer<typeof AlgorithmsSchema>;

/** Settings that a profile may inherit from `defaults`. */
const inheritable = {
  port: z.number().int().min(1).max(65535).optional(),
  username: z
    .string()
    .min(1)
    .optional()
    .describe(
      "RouterOS user. Append '+ct' (e.g. 'admin+ct') to disable colour and paging in RouterOS output.",
    ),
  auth: AuthSchema.optional(),
  hostKey: HostKeySchema.optional(),
  readOnly: z
    .boolean()
    .optional()
    .describe(
      "Reject commands that are not recognised as read-only. Defaults to true. A guardrail against accidents, not a security boundary — use RouterOS group permissions for that.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Connect + command timeout in milliseconds. Defaults to 20000."),
  algorithms: AlgorithmsSchema.optional().describe(
    "SSH algorithm overrides for routers that need legacy crypto.",
  ),
};

export const ProfileSchema = z
  .object({
    host: z.string().min(1).describe("Hostname or IP address of the router."),
    description: z.string().optional(),
    tags: z.array(z.string()).optional().describe("Free-form labels, searchable by the list tool."),
    ...inheritable,
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

export const DefaultsSchema = z.object(inheritable).strict();

export type Defaults = z.infer<typeof DefaultsSchema>;

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    defaults: DefaultsSchema.optional().describe("Applied to every profile in this file."),
    profiles: z
      .record(
        z.string().regex(/^[A-Za-z0-9._-]+$/, "Profile names may use letters, digits, '.', '_' and '-'."),
        ProfileSchema,
      )
      .describe("Router profiles, keyed by name."),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/** A profile with every default applied and its origin recorded. */
export interface ResolvedProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: Auth;
  hostKey: Required<Pick<HostKey, "policy">> & HostKey;
  readOnly: boolean;
  timeoutMs: number;
  algorithms?: Algorithms;
  description?: string;
  tags: string[];
  /** Absolute path of the config file this profile came from. */
  source: string;
}

export const DEFAULT_PORT = 22;
export const DEFAULT_USERNAME = "admin";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_READ_ONLY = true;
