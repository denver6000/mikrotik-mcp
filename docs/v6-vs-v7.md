---
title: RouterOS v6 and v7 differences
versions: [6, 7]
tags: [version, migration, v6, v7, bgp, ospf, routing, filter, wireless, wifi]
---

## What stays the same

v7 accepts v6-style command syntax, and the everyday menus are unchanged: `/ip address`, `/ip route`, `/ip firewall`, `/ip dhcp-server`, `/interface`, `/system`, `/log`, `/export`. A read written for v6 will normally work on v7 as written.

v7 also introduced a slash-separated CLI style (`/routing/bgp/connection` rather than `/routing bgp connection`). Both forms work; the space-separated form is the safer one to emit because v6 accepts it too.

The differences below are the ones that actually break.

## Dynamic routing was redesigned

This is the largest break. Configuration written for v6 dynamic routing does not carry over.

### OSPF (v6)

Separate menus for OSPFv2 and OSPFv3, with a default instance and a default area already present, and interfaces configured directly.

### OSPF (v7)

OSPFv2 and OSPFv3 are merged into one `/routing ospf` menu. There are **no default instances or areas** — both must be created before OSPF does anything. Interfaces are matched by template rather than configured individually:

```
/routing ospf instance
add name=v2inst version=2 router-id=1.2.3.4

/routing ospf area
add name=backbone_v2 area-id=0.0.0.0 instance=v2inst

/routing ospf interface-template
add network=192.168.0.0/24 area=backbone_v2
```

### BGP (v6)

Configured through `/routing bgp instance` and `/routing bgp peer`.

### BGP (v7)

Replaced by three menus. `template` holds protocol configuration and can be shared by a group of peers, `connection` defines each peer, and `session` is read-only status:

```
/routing/bgp/template
set default as=65533

/routing/bgp/connection
add remote.address=10.155.101.0/24 listen=yes template=default local.role=ibgp

/routing/bgp/session
print
```

Many parameters are grouped under `input` and `output` prefixes in v7 where v6 had them flat.

### Advertised networks (BGP)

v6 used a dedicated menu:

```
/routing bgp network add network=192.168.0.0/24
```

In v7 the networks are held in `/ip/firewall/address-list` and referenced from the BGP connection.

## Routing filters became a scripting language

v6 filters were built from discrete properties:

```
/routing filter
add prefix=172.16.0.0/16 prefix-length=24 protocol=static action=accept
```

v7 replaces this with rule expressions under `/routing/filter/rule`:

```
/routing/filter/rule
add chain=ospf_in rule="if (dst in 172.16.0.0/16 && dst-len==24 && protocol static) { accept }"
```

## Menus that moved

| Purpose | v6 | v7 |
| --- | --- | --- |
| Policy routing rules | `/ip route rule` | `/routing rule` |
| All-address-family route table | — | `/routing route` |
| BGP peers | `/routing bgp peer` | `/routing bgp connection` |
| BGP protocol settings | `/routing bgp instance` | `/routing bgp template` |
| Routing filters | `/routing filter` | `/routing filter rule` |

## Wireless

Three menus exist across the range, and which one a router has depends on both version and chipset:

- `/interface wireless` — v6, and v7 on hardware using the older wireless drivers.
- `/interface wifiwave2` — v7 before 7.13, where the functionality shipped in a separate `wifiwave2` package.
- `/interface wifi` — v7 from 7.13 onward, where that package was folded into the main menu.

Do not assume which is present. `/interface wireless print` failing with a "no such item" error usually means the router is on one of the newer menus.

## Containers

Container support exists only in v7. There is no `/container` menu in v6.

## Deciding which applies

Read `/system resource print` first and branch on the reported version. Emitting a v7 routing command at a v6 router produces a syntax error rather than anything harmful, but the reverse — a v6 BGP command on v7 — can silently configure nothing useful, because the old menu simply does not exist.
