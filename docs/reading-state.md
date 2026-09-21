---
title: Reading router state
versions: [6, 7]
tags: [read, print, status, interfaces, addresses, routes, firewall, dhcp, logs, health]
---

## System identity and version

```
/system identity print
/system resource print
/system package print
/system routerboard print
```

`/system resource print` carries the RouterOS version, uptime, CPU load, and free memory. It is the right first command against an unfamiliar router, because the version determines which menus below apply.

## Interfaces

```
/interface print
/interface print detail
/interface print where running=yes
/interface print stats
/interface monitor-traffic ether1 once
```

`monitor-traffic` is continuous by default. Always pass `once` in a non-interactive session, or the command will not return and will hit the profile timeout.

## Addresses and neighbours

```
/ip address print
/ip address print where interface=ether1
/ip arp print
/ip neighbor print
/ipv6 address print
```

## Routes

```
/ip route print
/ip route print where dst-address=0.0.0.0/0
/ip route print detail where active=yes
```

On v7 there is also a unified menu covering every address family with the full set of route attributes:

```
/routing route print
```

`/ip route` and `/ipv6 route` remain available in v7 for ordinary use, so a v6-style read works on both versions.

## Firewall

```
/ip firewall filter print
/ip firewall filter print where chain=input
/ip firewall nat print
/ip firewall address-list print
/ip firewall connection print count-only
```

Firewall rule listings are frequently long; add `without-paging`. Counters live in the same listing — `print stats` shows packet and byte counts per rule.

## DHCP

```
/ip dhcp-server print
/ip dhcp-server lease print
/ip dhcp-server lease print where status=bound
/ip dhcp-client print
```

## Wireless

Which menu exists depends on the version and the hardware — see the wireless section of the version-differences document. In short:

```
/interface wireless print                      # v6, and v7 on older chipsets
/interface wireless registration-table print

/interface wifi print                          # v7 from 7.13
/interface wifi registration-table print

/interface wifiwave2 print                     # v7 before 7.13
/interface wifiwave2 registration-table print
```

If the first one errors with a "no such item" style message, the router is using one of the others.

## Logs

```
/log print
/log print without-paging
/log print where topics~"error"
/log print where message~"login"
```

`~` is a regular-expression match, which is the usual way to filter logs since `topics` holds a list.

## Health and environment

```
/system health print
/system clock print
/system ntp client print
```

`/system health` reports voltage and temperature on hardware that has the sensors; on devices without them the listing is empty rather than an error. The property layout changed between versions, so read it with `print detail` rather than assuming column positions.

## Configuration export

```
/export
/export compact
/export file=backup
/ip firewall export
```

`/export` writes the whole configuration to the terminal, which can be very large. Prefer exporting a single menu when you only need one area. Note that an export may contain secrets such as PSKs unless the version supports hiding them.
