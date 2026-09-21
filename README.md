# mikrotik-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that runs RouterOS commands on MikroTik routers over SSH.

Node + TypeScript, no runtime toolchain of its own, and **stateless**: every tool call re-reads the config and opens and closes its own SSH connection. Nothing is cached, pooled or carried between calls.

It speaks JSON-RPC over stdio, so it drops into any MCP harness: Claude Code, Codex, opencode, Cursor, Zed, and anything else that can spawn a command.

> **Status:** the config, policy and SSH layers are covered by tests, including real SSH handshakes against a local test server. It has **not yet been run against physical MikroTik hardware** — run `mikrotik-mcp --test <profile>` against your own router first. Please report anything RouterOS does differently.

## Use it

```bash
npx -y mikrotik-mcp
```

The published package is plain Node ESM with no runtime toolchain of its own — Node 18+ is enough.

| Client | How to add it |
| ------ | ------------- |
| Claude Code | `claude mcp add mikrotik -- npx -y mikrotik-mcp` |
| Codex | `[mcp_servers.mikrotik]` in `~/.codex/config.toml` with `command = "npx"`, `args = ["-y", "mikrotik-mcp"]` |
| opencode | `"mikrotik": { "type": "local", "command": ["npx", "-y", "mikrotik-mcp"], "enabled": true }` under `"mcp"` in `opencode.json` |
| Anything else | `"mikrotik": { "command": "npx", "args": ["-y", "mikrotik-mcp"] }` under `"mcpServers"` |

If a profile uses password auth, the client also has to pass the variable holding it — see [Getting a secret to the server](#getting-a-secret-to-the-server).

## Quick start

### 1. Prepare the router

Create a dedicated RouterOS user rather than reusing `admin`. A read-only group is the real safety mechanism — the server's own `readOnly` check is only a guardrail.

```routeros
/user group add name=mcp-read policy=ssh,read,test
/user add name=mcp-readonly group=mcp-read
/ip service enable ssh
```

Then give it a key (preferred) or a password:

```routeros
# key auth — upload your public key first, e.g. with scp
/user ssh-keys import public-key-file=id_mikrotik.pub user=mcp-readonly

# or password auth
/user set mcp-readonly password="..."
```

### 2. Write a config file

Start from [`config.example.json`](config.example.json). For a first router, put this at `~/.mikrotik-mcp.json`:

```json
{
  "profiles": {
    "core": {
      "host": "10.0.0.1",
      "username": "mcp-readonly+ct",
      "description": "Core router"
    }
  }
}
```

That is a complete config. Everything else has a default: port 22, SSH-agent auth, `known_hosts` verification, read-only, 20 s timeout. The `+ct` suffix on the username tells RouterOS to drop colour codes and paging, which keeps the output readable.

### 3. Trust the host key

The first connection will be refused, on purpose, because the router is not in `known_hosts` yet. Either add it the normal way:

```bash
ssh-keyscan -H 10.0.0.1 >> ~/.ssh/known_hosts
```

…or, if you prefer to pin the key in the config, run the command once and copy the fingerprint out of the error message into `hostKey.fingerprintSha256`. Verify the fingerprint against the router itself (`/ip ssh print` shows the host key, or read it on the console) before trusting it.

### 4. Check it

```bash
npx -y mikrotik-mcp --check-config
```

```
Config search path (highest precedence first):
         C:\work\.mikrotik-mcp.json
  loaded C:\Users\you\.mikrotik-mcp.json

Profiles (1):
  core
    ssh       mcp-readonly+ct@10.0.0.1:22
    auth      agent
    host key  known-hosts
    writes    refused (readOnly)
    from      C:\Users\you\.mikrotik-mcp.json
```

This exits non-zero if a file is unparseable or no profiles were found, so it works in CI too. It reads the same files the server does, but connects to nothing.

### 5. Prove it against the router

`--check-config` never connects to anything. To test the whole path — TCP, host key, credentials, RouterOS — run:

```bash
npx -y mikrotik-mcp --test core
```

```
Connecting to 'core' (mcp-readonly+ct@10.0.0.1:22) as agent...
  host key   SHA256:9lK…  (accepted by policy 'known-hosts')
  command    /system identity print
  exit code  0
  took       412ms

  name: MikroTik-core

OK.
```

It runs one harmless read (`/system identity print`), prints `FAILED.` with the reason if anything goes wrong, and exits non-zero. Do this before wiring up an agent — it tells you whether a problem is in the config, the network, or the router.

### 6. Point your agent at it

Ask it to run `/system resource print` on `core`. It should call `mikrotik_list_profiles` first, then `mikrotik_exec`.

## Configuration

`defaults` applies to every profile in the same file; a profile overrides it field by field.

```json
{
  "$schema": "https://raw.githubusercontent.com/denver6000/mikrotik-mcp/main/schema/mikrotik-mcp.schema.json",
  "defaults": {
    "username": "mcp-readonly+ct",
    "auth": { "type": "agent" },
    "timeoutMs": 20000
  },
  "profiles": {
    "core": {
      "host": "10.0.0.1",
      "description": "Core router, main uplink",
      "tags": ["core", "site-a"]
    },
    "branch-a": {
      "host": "192.168.50.1",
      "port": 2222,
      "tags": ["branch", "site-b"],
      "hostKey": { "policy": "pinned", "fingerprintSha256": "SHA256:abc..." }
    },
    "lab": {
      "host": "10.20.0.1",
      "username": "admin+ct",
      "auth": { "type": "password", "passwordEnv": "MIKROTIK_LAB_PASSWORD" },
      "readOnly": false
    }
  }
}
```

Adding `$schema` gives you completion and validation in any editor that speaks JSON Schema.

### Profile fields

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `host` | — | Hostname or IP. Required. |
| `port` | `22` | SSH port. |
| `username` | `"admin"` | RouterOS user. Append `+ct` (`"admin+ct"`) to turn off colour and paging in RouterOS output. |
| `auth` | `{ "type": "agent" }` | See [Authentication](#authentication). |
| `hostKey` | `{ "policy": "known-hosts" }` | See [Host key verification](#host-key-verification). |
| `readOnly` | `true` | Refuse commands that are not recognised as read-only. |
| `timeoutMs` | `20000` | Connect + command timeout. |
| `algorithms` | — | SSH algorithm overrides for older routers. See below. |
| `description`, `tags` | — | Free-form, searchable by `mikrotik_list_profiles`. |

### Where the config is read from

Every one of these is loaded, highest precedence first. When two files define the same profile name the earlier one wins; profiles with different names merge into one list.

| # | Path |
| - | ---- |
| 1 | `$MIKROTIK_MCP_CONFIG` — one or more explicit paths, separated by `:` (`;` on Windows) |
| 2 | `.mikrotik-mcp.json` in the working directory, then each parent directory |
| 3 | `%APPDATA%\mikrotik-mcp\config.json` (Windows) |
| 4 | `$XDG_CONFIG_HOME/mikrotik-mcp/config.json`, else `~/.config/mikrotik-mcp/config.json` |
| 5 | `~/.mikrotik-mcp.json` |

Which to use:

- **One personal file** — `~/.mikrotik-mcp.json`. Fine for most people; start here.
- **Per-repo file** — `.mikrotik-mcp.json` committed alongside a network-automation repo, so anyone cloning it gets the right profiles. Safe to commit: it holds no secrets. Because parents are searched too, a file at the root of a monorepo covers every package under it.
- **Both** — the repo file wins for names it defines, and your personal file supplies the rest. This is how you override one router's settings locally without editing a shared file.
- **An explicit path** — `$MIKROTIK_MCP_CONFIG` for CI, or to keep several environments in separate files: `MIKROTIK_MCP_CONFIG=prod.json:staging.json`.

Files are re-read on every tool call, so edits take effect without restarting the server or the agent. `mikrotik_list_profiles` reports which file each profile came from and flags any it could not parse.

### Authentication

Secrets never go in the config file. A profile names the *environment variable* holding the secret and the value is read at connect time, so config files stay safe to commit and share.

```jsonc
{ "type": "agent" }                                          // key from a running SSH agent (default)
{ "type": "agent", "socket": "/run/user/1000/ssh-agent" }    // explicit agent socket
{ "type": "key", "path": "~/.ssh/id_mikrotik" }              // private key file
{ "type": "key", "path": "~/.ssh/id_mikrotik", "passphraseEnv": "MTK_KEY_PASS" }
{ "type": "password", "passwordEnv": "MIKROTIK_LAB_PASSWORD" }
```

`~` and `$VARS` are expanded in paths. On Windows, agent auth defaults to the OpenSSH named pipe when `SSH_AUTH_SOCK` is unset. Password auth also answers keyboard-interactive prompts with the same secret, since RouterOS may offer that instead of plain password auth.

#### Getting a secret to the server

Your MCP client launches this server as a **subprocess**, so a variable exported in your interactive shell does not necessarily reach it. Either use agent or key auth — which need no variables, and are the reason `agent` is the default — or declare the variable in the client's own config. The field differs per client:

```bash
# Claude Code
claude mcp add mikrotik --env MIKROTIK_LAB_PASSWORD=... -- npx -y mikrotik-mcp
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.mikrotik]
command = "npx"
args = ["-y", "mikrotik-mcp"]
env = { MIKROTIK_LAB_PASSWORD = "..." }
```

```json
// opencode — note "environment", not "env"
{
  "mcp": {
    "mikrotik": {
      "type": "local",
      "command": ["npx", "-y", "mikrotik-mcp"],
      "enabled": true,
      "environment": { "MIKROTIK_LAB_PASSWORD": "..." }
    }
  }
}
```

```json
// generic mcpServers config
{
  "mcpServers": {
    "mikrotik": {
      "command": "npx",
      "args": ["-y", "mikrotik-mcp"],
      "env": { "MIKROTIK_LAB_PASSWORD": "..." }
    }
  }
}
```

Note the trade-off: this moves the password out of the router config and into the client config, which is usually not a file you want to commit either. Key or agent auth avoids the problem entirely.

### Host key verification

On by default. A router whose key is unknown is refused, and the error prints the fingerprint so you can verify it and then trust it.

```jsonc
{ "policy": "known-hosts" }                                       // default; ~/.ssh/known_hosts
{ "policy": "known-hosts", "knownHostsPath": "~/.ssh/routers" }
{ "policy": "pinned", "fingerprintSha256": "SHA256:abc..." }      // pin one key in the config
{ "policy": "insecure-ignore" }                                   // accept anything — lab use only
```

Setting `fingerprintSha256` without a `policy` implies `pinned`. Hashed `known_hosts` entries, wildcards, `[host]:port` entries and negated patterns are all handled. A host that is known but presents a *different* key is a hard failure, never a prompt.

### Older routers: legacy crypto

Modern SSH clients no longer enable the key exchange and host key algorithms that older RouterOS releases — or routers with *strong crypto* disabled — may be limited to. If the connection fails during handshake rather than at login, add what that router needs:

```json
{
  "host": "10.0.0.1",
  "algorithms": {
    "kex": { "append": ["diffie-hellman-group14-sha1"] },
    "serverHostKey": { "append": ["ssh-rsa"] }
  }
}
```

`append`, `prepend` and `remove` are passed through to the SSH layer, as are plain arrays if you want to specify the whole list. Prefer upgrading RouterOS or enabling strong crypto on the router over weakening the client.

### Read-only by default

Profiles are `readOnly: true` unless you say otherwise. Commands are classified before connecting: a command must contain a recognised read action (`print`, `get`, `find`, `export`, `monitor`, `ping`, …) and no recognised write action (`set`, `add`, `remove`, `reboot`, …). Every command in a `;`- or newline-separated chain is checked, so a read cannot smuggle a write along with it. Anything the classifier does not understand is treated as a write and refused.

> This is a guardrail against accidents, **not a security boundary**. A determined agent, or a command phrased in a way the classifier does not model, can get past it. For real enforcement, log in as a RouterOS user whose group grants read access only — the router is the only thing that can enforce that. Set `readOnly: false` on profiles where writes are intended.

### Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| `No profiles found` | The config is not on the search path. Run `--check-config` — it prints every path it checked. |
| A path shows `FAILED` | The file exists but is invalid JSON or breaks the schema; the reason is printed under *Problems*. Unknown keys are rejected, so check for typos like `porrt`. |
| `Host key for … is not in …known_hosts` | Expected on first contact. Verify the printed fingerprint, then add it to `known_hosts` or pin it. |
| `HOST KEY CHANGED` | The router presented a different key than last time. Do not bypass this until you know why. |
| `Environment variable … is not set` | The client did not pass it to the subprocess — see [Getting a secret to the server](#getting-a-secret-to-the-server). |
| `Refused: profile … is read-only` | Intended. Set `readOnly: false` on that profile if writes are wanted. |
| `All configured authentication methods failed` | Wrong user, wrong key, or the RouterOS group lacks the `ssh` policy. |
| Handshake fails before any login prompt | Algorithm mismatch with an older router — see [Older routers: legacy crypto](#older-routers-legacy-crypto). |
| A command fails but `exit code` is 0 | RouterOS often reports errors in its output rather than through the exit status, so read the text, not just the status. |
| Output is full of escape codes | Add `+ct` to the username (`"admin+ct"`). |

## Command line

| Command | Purpose |
| ------- | ------- |
| `mikrotik-mcp` | Start the MCP server on stdio (what your client runs). |
| `mikrotik-mcp --check-config` | Show every config path checked, what loaded, and what each profile resolves to. Connects to nothing. Exits non-zero on a bad or empty config. |
| `mikrotik-mcp --test <profile>` | Connect to that router and run one harmless read. Exits non-zero on failure. |
| `mikrotik-mcp --version`, `--help` | As expected. |

## Tools

### `mikrotik_list_profiles`

Search the configured routers. Returns connection details, which config file each came from, whether it is read-only, and any config problems. Never returns secrets — only the name of the variable holding one.

| Input | Type | Notes |
| ----- | ---- | ----- |
| `query` | string, optional | Case-insensitive substring over name, host, description and tags. |

### `mikrotik_exec`

Run one RouterOS command on one router and return its output.

| Input | Type | Notes |
| ----- | ---- | ----- |
| `profile` | string | Profile name. |
| `command` | string | e.g. `/system resource print`. |
| `timeoutMs` | number, optional | Overrides the profile's timeout. |

Returns stdout, stderr, the exit code and the host key fingerprint, as text and as structured content. Because each call is a fresh connection with no shell state, commands must use absolute RouterOS paths (`/ip address print`, not `print` after a `cd`).

## Develop

No extra toolchain: Node runs the TypeScript sources directly via built-in type stripping, so `npm install` is the whole setup. **Node 22.18+ is required for development**; the published package supports Node 18+.

```bash
npm install
npm run dev         # run the server on stdio, straight from src/
npm test            # unit tests + a real SSH round-trip against a local ssh2 server
npm run typecheck
npm run schema      # regenerate schema/mikrotik-mcp.schema.json from the zod schema
npm run build       # emit dist/ with tsc
npm run inspect     # open the MCP Inspector against src/
```

### Layout

```
src/
  index.ts             CLI entry: arg handling + stdio transport
  server.ts            createServer() — registers every tool
  config/
    schema.ts          zod schema for the config file, and the resolved profile type
    paths.ts           where config files are looked for; ~ and $VAR expansion
    load.ts            read, validate, merge, search
    report.ts          the --check-config report
  ssh/
    exec.ts            one connection, one command, then close
    knownHosts.ts      known_hosts parsing and host key verification
    policy.ts          read-only command classification
    testConnection.ts  the --test <profile> probe
  tools/
    listProfiles.ts    mikrotik_list_profiles
    exec.ts            mikrotik_exec
scripts/
  generate-schema.ts   zod schema -> JSON Schema
test/                  node:test suites; helpers.ts builds a sandboxed config + env
```

Every entry point takes an injectable `LookupEnvironment` (`env`, `cwd`, `home`, `platform`) so tests never touch the real user's config or SSH agent.

### Adding a tool

1. Add `src/tools/<name>.ts` exporting a `register…Tool(server, e)` function.
2. Call it from `createServer()` in `src/server.ts`.
3. Add a case to `test/server.test.ts`.

Relative imports use explicit `.ts` extensions so Node can run the sources as-is; `tsc` rewrites them to `.js` on build. Keep `stdout` clean — it is the JSON-RPC channel. Log to `stderr` only.

## Release

`version` lives in both `package.json` and `SERVER_VERSION` in `src/server.ts`; bump both.

```bash
npm test && npm run build
npm publish          # prepublishOnly rebuilds dist/
```

Only `dist/`, `schema/`, `README.md` and `LICENSE` are published.

## License

MIT
