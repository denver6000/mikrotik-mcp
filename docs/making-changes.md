---
title: Making changes safely
versions: [6, 7]
tags: [write, set, add, remove, enable, disable, safe-mode, lockout, comment]
---

## Before anything else

Writes are refused unless the profile sets `readOnly: false`. That check is a guardrail, not a security boundary — the durable protection is a RouterOS user whose group grants read access only. Use a read-write profile deliberately and only where writes are intended.

## Select by predicate, never by number

Item numbers are reassigned per session and again on the next `print`, so a number is only valid in the instant it was displayed. Every command here runs in its own session, which makes any number carried between calls meaningless. It will not error — it will act on whatever holds that number now.

```
# wrong: the number came from a previous command
/ip firewall filter remove 3

# right: the predicate describes the item
/ip firewall filter remove [find where comment="temporary-allow"]
```

Give rules a `comment` when you create them. A comment is the only durable handle a rule has.

```
/ip firewall filter add chain=input action=accept protocol=icmp comment="mcp-icmp"
/ip firewall filter set [find where comment="mcp-icmp"] disabled=yes
/ip firewall filter remove [find where comment="mcp-icmp"]
```

## Verify the predicate first

`find` is cheap and non-destructive. Run the read before the write and confirm it matches exactly what you expect:

```
/ip firewall filter print where comment="mcp-icmp"
```

A predicate matching more items than intended is the usual cause of an over-broad `remove`.

## Commands that can lock you out

These can sever the connection you are issuing them over. There is no undo, and in a non-interactive session there is no confirmation prompt:

- `/system reboot`, `/system shutdown`
- `/system reset-configuration`
- `/ip address remove` on the address you are connected through
- `/ip firewall filter add chain=input action=drop` without an accept rule above it for your own access
- `/ip service disable ssh`
- `/user remove` or `/user set` on the account in use

Safe mode, which rolls back changes if the session drops, is an interactive console feature. It does not apply here: each command is its own session that ends immediately, so a rollback would trigger the moment the command finished.

## Ordering matters in the firewall

Rules are evaluated top to bottom, and `add` appends to the end by default. A rule added after a terminating `drop` will never be reached. Use `place-before` to position it:

```
/ip firewall filter add chain=input action=accept protocol=icmp place-before=[find where action=drop and chain=input]
```

## Making a change reversible

Prefer disabling to removing while testing, since it is trivially undone:

```
/ip firewall filter set [find where comment="mcp-icmp"] disabled=yes
/ip firewall filter set [find where comment="mcp-icmp"] disabled=no
```

Export the affected menu before changing it, so there is a record of the prior state:

```
/ip firewall export
```

## Checking the result

RouterOS frequently reports failures in its output text while still exiting zero. Do not treat a zero exit code as success — read the output, then confirm with a follow-up read that the intended state is now in place.
