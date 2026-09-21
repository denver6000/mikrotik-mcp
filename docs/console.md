---
title: Console basics — output, selection and safety
versions: [6, 7]
tags: [console, print, find, output, paging, numbering]
---

## Controlling output

Every menu's `print` command accepts modifiers that change the shape of its output. Pick the one that matches what you are trying to read.

- `print` on its own gives the default tabular listing.
- `print detail` switches to `property=value` form, which is the one to use when you need a field that the tabular form omits.
- `print brief` forces the tabular form.
- `print count-only` returns just the number of items — cheaper than counting rows yourself.
- `print without-paging` returns the whole listing instead of stopping after each screenful. Worth adding to any command whose output may be long.
- `print where <condition>` filters to matching items only.

Because each command runs in its own SSH session with no terminal attached, paging and colour are usually already suppressed. If output still arrives full of escape sequences or pauses, append `+ct` to the username in the profile (`admin+ct`), which tells RouterOS to disable colour and terminal detection for that login.

## Selecting items: never use numbers

Item numbers shown by `print` are **not stable identifiers**. They are assigned per session, and they are reassigned when the next `print` runs. Two consequences:

- A number read in one command is meaningless in another. Every command here is a separate SSH session, so a number from an earlier call is always stale.
- Even inside one command chain, a second `print` can renumber everything.

Acting on a stale number does not fail — it acts on **whatever now holds that number**. On a write, that is how the wrong firewall rule gets removed.

Always select by predicate instead:

```
/ip firewall filter remove [find where comment="old-rule"]
/interface set [find where name=ether2] disabled=yes
/ip address print where interface=ether1
```

`find` accepts the same arguments as `set`, plus flag arguments such as `disabled` and `active` which take `yes`/`no`. It returns the internal numbers of every matching item, so it composes directly into `remove`, `set`, `enable` and `disable`.

## Combining commands

`;` separates commands on one line. Each runs in order, in the same session.

```
/system identity print; /system resource print
```

Note that this server checks every command in such a chain against the read-only policy, so a chain cannot be used to slip a write past a read-only profile.

## Reading results as data

Square brackets substitute the result of one command into another, which is how you extract a single value rather than a whole table:

```
:put [/system resource get uptime]
:put [/interface get [find where name=ether1] running]
```

`get` returns one property of one item; `find` supplies the item. This pairing is usually clearer to parse than filtering `print detail` output.

## Reported but unverified

The following are in common use but were not confirmed against the official console documentation while writing this. Verify on your own hardware before depending on them:

- `print terse` — one line per item, intended for machine parsing.
- `print as-value` — returns an array suitable for scripting, typically used as `:put [/ip address print as-value]`.
