---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Index of Architecture Decision Records and how to write one.
---

# Architecture Decision Records

An ADR records **why** a significant decision was made, so a future engineer does
not have to rediscover the reasoning — or worse, silently reverse it.

Write an ADR when a decision is hard to reverse, spans more than one subsystem,
or rules out an option someone would otherwise reach for. Do **not** write one for
routine implementation choices.

## Format

Each ADR has five sections: **Context → Decision → Alternatives → Consequences →
Status**.

Two statuses are in play and they mean different things:

- The **frontmatter `status`** is always `Reference` — an ADR is a historical
  record, so it is never "out of date with the code" in the way a guide is.
- The **`## Status` section in the body** carries the decision's own lifecycle:
  `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Rejected`.

Never edit an accepted ADR's decision. To change course, write a new ADR and mark
the old one `Superseded by ADR-NNNN`.

## Index

| ADR                                            | Title                                                      | Status   |
| ---------------------------------------------- | ---------------------------------------------------------- | -------- |
| [0001](0001-account-authentication.md)         | Account authentication: OAuth + magic link, no passwords   | Accepted |
| [0002](0002-device-identity.md)                | Device identity: Ed25519 keypair with challenge-response   | Accepted |
| [0003](0003-same-account-device-visibility.md) | Same-account device visibility replaces QR pairing         | Accepted |
| [0004](0004-signaling-horizontal-scaling.md)   | Signaling scale-out: in-memory rooms + Redis pub/sub relay | Accepted |
| [0005](0005-turn-topology.md)                  | TURN topology: dedicated regional VMs, not Kubernetes      | Accepted |
| [0006](0006-lan-first-connectivity.md)         | LAN-first: the laptop is its own control plane             | Accepted |
| [0007](0007-cloud-is-control-plane-only.md)    | The cloud is a control plane, never a data plane           | Accepted |
