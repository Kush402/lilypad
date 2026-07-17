# 🪷 Lilypad

**Internet-first, phone-first remote laptop control.** A lightweight desktop app
shows a floating "Lilypad" bubble; click it to display a short-lived QR code.
Scan it from the phone, **approve on the laptop**, and your laptop screen streams
live to the phone with touch, keyboard, and developer shortcuts — **over the
public internet**, not just the same Wi-Fi.

Transport is **WebRTC + STUN + TURN (coturn)**. No custom video protocol, no
LAN-only design, **no silent remote access**.

> **Status: Milestone 1** — repo, infra, backend health + pairing service,
> desktop shell (bubble/QR/approve), mobile QR scanner. See
> [docs/milestones.md](docs/milestones.md).

## Monorepo layout

```
apps/
  desktop/   Tauri v2 + Rust — bubble, tray, QR overlay, plugin host, capture/input
  mobile/    React Native (bare) — scanner, viewer, dev input toolbar
  backend/   Fastify — REST (health, pairing) + WS signaling, Redis, Postgres
  admin/     React + Vite — dashboard (wired in M6)
packages/
  protocol/  zod schemas + types: QR payload, signaling, input, pairing
  shared/    env parsing, logger, Redis keys, constants
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
  > auto-fixes this (adds the source to `~/.zshenv`); `pnpm doctor` diagnoses it.
- **Mobile** (to run on a device/simulator): Xcode + CocoaPods (iOS) or Android
  Studio + JDK 17. See [apps/mobile/README.md](apps/mobile/README.md).

## Quick start

```bash
# 0. Diagnose your machine (✅/⚠/❌ with exact repair steps for every tool)
pnpm doctor

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
| `pnpm doctor`                  | Check every prerequisite (✅/⚠/❌ + repair steps)                                   |
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

## How pairing works (M1)

1. Desktop clicks bubble → `POST /pairing/create` → single-use token (Redis, 60s).
2. Desktop shows the QR (`{ token, roomId, apiBaseUrl, signalingUrl }`).
3. Phone scans → `POST /pairing/redeem` → token is **burned** (single-use).
4. Desktop shows **Approve/Deny** (full signaling + streaming in M2–M4).

## Docs

Start with [docs/architecture.md](docs/architecture.md) and
[docs/technical-design.md](docs/technical-design.md).

## License

Proprietary — all rights reserved (placeholder).
