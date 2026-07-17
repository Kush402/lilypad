# Contributing to Lilypad

## Getting set up

```bash
pnpm doctor      # verifies every prerequisite with repair steps
pnpm bootstrap   # installs deps, starts infra, runs migrations — idempotent
```

See the [README](README.md) for per-app run commands and
[docs/architecture.md](docs/architecture.md) for how the pieces fit.

## Ground rules

- **Every change ships with its tests.** Backend logic is unit-tested with
  vitest; mobile gesture/screen logic with jest; desktop Rust with `cargo
  test` (pure logic is kept in dependency-free modules precisely so it can
  be). If you fixed a bug, add the test that would have caught it.
- **The protocol package is the single source of truth** for anything that
  crosses a process boundary. Change `packages/protocol` first; the Rust
  mirror in `apps/desktop/src-tauri/src/signaling/messages.rs` and
  `src/input/protocol.rs` must be updated in the same PR — the backend's
  protocol-drift test will fail otherwise.
- **No silent remote access, ever.** Anything that could start capture or
  inject input without the explicit desktop-side approval flow will not be
  merged, regardless of how convenient it is for testing.
- **Fail closed at boundaries.** Input events are dropped (and counted) when
  scope, permission, or gating disallows them — never "best-effort injected."

## Style

- TypeScript: ESLint + Prettier are enforced (`pnpm lint`, `pnpm format`).
- Rust: `cargo fmt` and a clean `cargo clippy --all-targets`.
- Comments explain **why**, not what. Match the density and register of the
  file you're editing.

## Before you push

```bash
pnpm lint && pnpm typecheck
pnpm --filter @lilypad/backend exec vitest run
pnpm --filter @lilypad/mobile test
(cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets)
```

## Commit / PR conventions

- Small, reviewable commits with imperative subjects ("bound reason fields",
  not "bounded" / "misc fixes").
- PRs describe the user-visible behavior change first, implementation second,
  and name the tests that cover it.
