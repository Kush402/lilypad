# 🪷 Lilypad

**Phone-first remote laptop control — your computer, anywhere.** A lightweight
desktop app shows a floating "Lilypad" bubble; pair your phone once, and your
laptop screen streams live to it with touch, keyboard, and developer shortcuts.

**At home, it connects directly over your own network — no internet required.**
Away from home, it connects over the internet, peer-to-peer wherever possible.

Transport is **WebRTC + STUN + TURN (coturn)**, chosen cheapest-path-first:
**LAN direct → internet P2P → TURN relay only when nothing else works.** Your
screen never passes through our servers — it is direct on LAN and P2P, and
end-to-end encrypted (DTLS-SRTP) on the rare occasions it must be relayed.

No custom video protocol, **no silent remote access**, and no cloud dependency
for a session between two devices on the same network. See
[docs/NETWORKING.md](docs/NETWORKING.md).

> **Status (2026-08-23, pre-launch)** — working end-to-end on real hardware over
> cellular: **pair once with a QR, reconnect forever without one** (My Devices →
> Connect rings the Mac), live H.264 streaming (ScreenCaptureKit → VideoToolbox
> → WebRTC) with self-healing recovery, touch/keyboard/clipboard input,
> pinch-zoom viewer, accounts with Ed25519 device identity
> ([ADR-0002](docs/adr/0002-device-identity.md)), explicit device linking
> ([ADR-0010](docs/adr/0010-explicit-device-linking.md)), a device dashboard on
> both clients, and the **Ask** AI operator (tiered, sandboxed, model-agnostic)
> driving the Mac from the phone.
>
> **Distribution, stated here because a README is a claim:** since v0.1.7 the
> macOS bundle is **signed with a Developer ID and notarized by Apple**, and
> the DMG carries its own stapled ticket — Gatekeeper accepts it with no
> warning, offline included. It ships from team `AR2Q4Y465L`, a collaborator's
> Apple Developer account, not the repository owner's. The iPhone app is on
> **TestFlight by invitation** (App Store Connect record "Lilypad RC"); there
> is no public App Store listing yet.
>
> Installers and updates are served from **lilypadhome.takedia.com**, not from
> GitHub Releases: a customer-facing URL should not depend on a repository
> setting. Releases remain the build record. See
> [docs/RUNBOOK.md](docs/RUNBOOK.md), and
> [docs/kanban.md](docs/kanban.md) for everything found in the pre-launch review
> and what happened to it.

## Monorepo layout

```
apps/
  desktop/   Tauri v2 + Rust — bubble, tray, QR overlay, capture/encode, input injection
  mobile/    React Native (bare) — scanner, viewer, dev input toolbar
  backend/   Fastify — REST (health, pairing) + WS signaling, Redis, Postgres
  admin/     React + Vite — dashboard (wired in M6)
  site/      Static marketing site — lilypadhome.takedia.com (P4)
packages/
  protocol/  zod schemas + types: QR payload, signaling, input, pairing
  shared/    env parsing, logger, Redis keys, constants
  design/    colour tokens (both schemes), radii, font stack — CSS + TS
infra/       docker-compose: Postgres, Redis, coturn
docs/        architecture, technical design, schema, API, protocols, threat model
```

## Prerequisites

- **Node ≥ 20**, **pnpm ≥ 9**, **Docker** (present: node 25, pnpm 10, Docker 29).
- **Rust toolchain** (`rustup`) — required for the desktop app; **not installed
  by default**:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  # macOS also needs Xcode Command Line Tools: xcode-select --install
  # See https://tauri.app/start/prerequisites/ for Windows (MSVC + WebView2).
  ```
  > **zsh + rustup gotcha:** rustup adds its PATH line to `~/.profile`, which
  > **zsh does not source** — so `cargo` is installed but invisible, and
  > `tauri dev` fails with `failed to run 'cargo metadata'`. `pnpm bootstrap`
  > auto-fixes this (adds the source to `~/.zshenv`); `pnpm env:check` diagnoses it.
- **Mobile** (to run on a device/simulator): Xcode + CocoaPods (iOS) or Android
  Studio + JDK 17. See [apps/mobile/README.md](apps/mobile/README.md).

## Quick start

```bash
# 0. Diagnose your machine (✅/⚠/❌ with exact repair steps for every tool)
pnpm env:check

# 1. One command to prepare everything: validates prerequisites, self-heals the
#    zsh/cargo PATH, installs deps, starts infra, runs migrations, verifies the
#    build. Idempotent — safe to re-run.
pnpm bootstrap

#    The desktop launch below self-heals the cargo PATH, so it works even if
#    cargo isn't on your shell's PATH yet. For bare `cargo` commands, open a
#    new terminal (or `source ~/.cargo/env`).

# 2. Configure env (bootstrap does not overwrite an existing .env)
cp .env.example .env    # first time only

# 3. Run the backend            → curl http://localhost:8080/health  ·  /metrics
pnpm --filter @lilypad/backend dev

# 4. Run the desktop app (floating bubble + tray + QR)
pnpm --filter @lilypad/desktop tauri dev

# 5. Run the mobile app (needs full Xcode / Android SDK — see apps/mobile/README.md)
cd apps/mobile && pnpm pods && pnpm ios      # or: pnpm android
```

**No GUI/device?** Verify the whole media path headlessly (two terminals):

```bash
# backend must be running (step 3)
cd apps/desktop/src-tauri
LILYPAD_SIGNALING=ws://localhost:8080/ws/signal LILYPAD_ROOM=demo \
  LILYPAD_CAPTURE_KIND=synthetic LILYPAD_RUN_SECS=15 cargo run --example headless_offer
# second terminal, same dir:
LILYPAD_SIGNALING=ws://localhost:8080/ws/signal LILYPAD_ROOM=demo \
  cargo run --example headless_mobile_peer   # → "TOTAL RTP VIDEO PACKETS RECEIVED: <thousands>"
```

## Handy scripts (root)

| Command                        | Does                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm env:check`               | Check every prerequisite (✅/⚠/❌ + repair steps)                                   |
| `pnpm bootstrap`               | Prepare a clean machine end-to-end (self-healing)                                   |
| `pnpm build`                   | Turborepo build across the workspace                                                |
| `pnpm typecheck`               | Typecheck all TS packages                                                           |
| `pnpm lint`                    | ESLint across packages                                                              |
| `pnpm format`                  | Prettier write                                                                      |
| `pnpm infra:up` / `infra:down` | Start/stop all infra                                                                |
| `pnpm clean`                   | Reclaim disk: build caches + mobile outputs (keeps dep caches — rebuilds stay fast) |
| `pnpm clean:build`             | JS/Rust build output only (dist, examples, incremental, release)                    |
| `pnpm clean:cargo`             | Full `target/` wipe (~16 GB; next build recompiles all deps)                        |
| `pnpm clean:mobile`            | Android/iOS build outputs, Gradle cache, Pods                                       |
| `pnpm clean:deps`              | Remove all node_modules (run `pnpm install` after)                                  |
| `pnpm clean:all`               | Everything above (nuclear: full rebuild + reinstall)                                |

> Rust `target/` dominates disk (build cache, git-ignored). `pnpm clean` frees
> the bulk without a full recompile; `pnpm clean:cargo` reclaims the rest when
> you need the space more than the fast rebuild.

## How a session works

1. Desktop clicks the bubble → `POST /pairing/create` → single-use token (Redis, 60s TTL).
2. Desktop shows the QR (`{ token, roomId, apiBaseUrl, signalingUrl }`).
3. Phone scans → `POST /pairing/redeem` → token is **burned** (single-use).
4. Desktop shows **Approve / Deny** — no session ever starts silently.
5. On approve, both peers get fresh time-limited TURN credentials and exchange
   SDP/ICE over the WebSocket signaling room.
6. WebRTC connects: H.264 video streams desktop → phone; touch/keyboard/
   clipboard events flow phone → desktop over a DataChannel, gated by the
   session's granted scope (`view` vs `control`) at the injection boundary.
7. A dropped transport mid-session holds the seat for a grace window and
   recovers with an ICE restart instead of ending the session.

**After the first pairing, steps 1–3 are optional.** If the phone ticked "Trust
this device", it stores the pair (keychain identity + per-pair connect secret)
and later calls `POST /connect/request` instead: the backend verifies the pair,
mints the same room-auth-bound session, and rings the Mac over its presence
channel. Step 4 still applies unless that pair is set to **Always allow** — and
either side can sever the trust at any time (desktop **Revoke**, phone
**Forget**), which also kills any live session for the pair immediately.

## Testing

```bash
pnpm test                                        # every JS/TS suite via turbo (537 tests)
pnpm --filter @lilypad/backend exec vitest run   # backend (unit + route + protocol drift) — 288
pnpm --filter @lilypad/mobile test               # mobile (jest, gesture/screen/logic) — 189
pnpm --filter @lilypad/desktop exec vitest run   # desktop UI (vitest + testing-library) — 44
pnpm --filter @lilypad/mobile typecheck
cd apps/desktop/src-tauri && cargo test          # desktop (unit + fault-injection + soak) — 277
```

All suites are expected green before any commit; CI enforces the same set plus
`cargo fmt --check` and `cargo clippy`.

## Troubleshooting

| Symptom                                    | Cause / fix                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone can't reach backend after scanning   | Phone and laptop must be on the same network for LAN dev. The backend auto-detects its LAN IP at boot — restart `pnpm --filter @lilypad/backend dev` after switching networks.                                                              |
| Desktop shows a blank window in dev        | The Vite dev server died (it must outlive the Tauri process). Restart `tauri dev`, or run Vite and the binary separately.                                                                                                                   |
| macOS keeps re-asking for Screen Recording | Unsigned dev builds get a new code signature each rebuild, so TCC re-prompts. When launched from a terminal, macOS attributes the permission to the _terminal app_ — grant it there. A signed production bundle does not have this problem. |
| `pairing/create` returns 429               | Per-IP rate limit (30/min). Wait a minute; don't script against it.                                                                                                                                                                         |
| Session dies when the phone locks          | Fixed in v1.0 (keep-awake + display-sleep assertions) — if you still see it, check `RUST_LOG=info` desktop output for `capture stream stopped`.                                                                                             |

## Docs

| Topic                              | Where                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Full index & verified status**   | [docs/PROJECT-INDEX.md](docs/PROJECT-INDEX.md)                                                                                    |
| Build, release & auto-update       | [docs/RUNBOOK.md](docs/RUNBOOK.md) · [apps/mobile/docs/RELEASE.md](apps/mobile/docs/RELEASE.md)                                   |
| Milestone status                   | [docs/milestones.md](docs/milestones.md)                                                                                          |
| Architecture & design              | [docs/architecture.md](docs/architecture.md) · [docs/technical-design.md](docs/technical-design.md)                               |
| REST + signaling API               | [docs/api.md](docs/api.md) · [docs/signaling-protocol.md](docs/signaling-protocol.md)                                             |
| Input protocol                     | [docs/input-protocol.md](docs/input-protocol.md)                                                                                  |
| Database schema                    | [docs/db-schema.md](docs/db-schema.md)                                                                                            |
| Security / threat model            | [docs/threat-model.md](docs/threat-model.md) · [SECURITY.md](SECURITY.md)                                                         |
| Operations & deployment            | [docs/operations.md](docs/operations.md)                                                                                          |
| End-user guide                     | [docs/user-guide.md](docs/user-guide.md)                                                                                          |
| Trusted devices (M5.4)             | [docs/m5.4-trusted-devices-audit.md](docs/m5.4-trusted-devices-audit.md)                                                          |
| Ask AI operator (M5.3)             | [docs/ask-architecture-audit.md](docs/ask-architecture-audit.md) · [docs/m5.3-ai-executor-plan.md](docs/m5.3-ai-executor-plan.md) |
| Device identity (M5, forward spec) | [docs/m5-auth-design.md](docs/m5-auth-design.md)                                                                                  |
| OAuth / sign-in setup (M8)         | [docs/oauth-setup.md](docs/oauth-setup.md)                                                                                        |
| Changelog                          | [CHANGELOG.md](CHANGELOG.md)                                                                                                      |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

Proprietary — all rights reserved. (A final license is a pending business
decision; do not redistribute until one is chosen.)
