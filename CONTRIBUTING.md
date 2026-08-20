# Contributing to Lilypad

## Getting set up

```bash
pnpm doctor      # verifies every prerequisite with repair steps
pnpm bootstrap   # installs deps, starts infra, runs migrations — idempotent
```

See the [README](README.md) for per-app run commands and
[docs/architecture.md](docs/architecture.md) for how the pieces fit.

## Before you push

```bash
pnpm verify      # exactly what CI runs, in the same order
```

Run this and not a subset. The habit of running `pnpm typecheck && pnpm test`
and calling it checked is what left `main` red on **every single CI run** for
weeks: `cargo fmt --check` had never been satisfied, and no TypeScript command
was ever going to say so. `pnpm verify` exists so "the check I ran" and "the
check CI runs" are the same list.

`pnpm rust:fmt` fixes the Rust half in place, the way `pnpm format` does for
TypeScript.

`rust:check` **`cd`s into the crate** rather than passing `--manifest-path`,
which looks like a stylistic choice and is not. Run from the repo root, the
test binary aborts on launch with

```
dyld: Library not loaded: @rpath/libswift_Concurrency.dylib
```

Run from `apps/desktop/src-tauri`, the identical binary passes. The
Swift-interop crates (`screencapturekit`, `apple-cf`, `apple-metal`) emit that
dylib from a build script and record **relative** rpath entries, so it only
resolves when the working directory is the crate. CI never saw this because its
Rust job already runs from that directory.

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
- **Documentation drift is a bug.** Docs change in the same PR as the code, not
  in a cleanup pass afterwards. See below.

## Documentation

`pnpm docs:check` runs in CI and fails the build on drift. It enforces three
things, each because that exact failure has already happened here:

1. **Every file under `docs/` declares frontmatter** — `status`, `owner`, and
   `last-verified`. A doc that does not say how current it is cannot be trusted.
2. **Every relative link resolves.**
3. **Every HTTP route registered in the backend appears in
   [docs/api.md](docs/api.md), and vice versa.** Five shipped routes once lived
   in the code and nowhere in the docs; this makes that state unmergeable.

### Status values

| Status         | Meaning                                                   |
| -------------- | --------------------------------------------------------- |
| `Implemented`  | Describes what the code does today                        |
| `In Progress`  | Partially built; the doc currently leads the code         |
| `Planned`      | Design only, nothing built                                |
| `Experimental` | Built, not committed to                                   |
| `Deprecated`   | Still accurate, on the way out                            |
| `Superseded`   | Replaced; kept for history, points at its replacement     |
| `Reference`    | Historical record (audits, ADRs) — cited, never "current" |

**Never leave a doc claiming something is unbuilt when it has shipped**, or
implemented when it has not. If you change a status, update `last-verified` to
the date you actually checked it against the code.

### What to update when

| You changed…               | Also update                                                   |
| -------------------------- | ------------------------------------------------------------- |
| An HTTP or WS route        | `docs/api.md` (CI enforces), `docs/architecture.md`           |
| The database schema        | `docs/db-schema.md`, a Drizzle migration                      |
| Anything security-relevant | `docs/threat-model.md` + the test that proves the fix         |
| Infrastructure             | `docs/operations.md`, `docs/RUNBOOK.md`                       |
| Desktop/mobile behavior    | `docs/user-guide.md`, `docs/architecture.md`                  |
| A milestone's status       | `docs/milestones.md`, `docs/PROJECT-INDEX.md`, `CHANGELOG.md` |

### Architecture Decision Records

Significant decisions get an ADR in [docs/adr/](docs/adr/) — hard-to-reverse
choices, anything spanning multiple subsystems, or anything that rules out an
option someone would otherwise reach for. Routine implementation choices do not.
Never edit an accepted ADR; supersede it with a new one.

## Style

- TypeScript: ESLint + Prettier are enforced (`pnpm lint`, `pnpm format`).
- Rust: `cargo fmt` and a clean `cargo clippy --all-targets`.
- Comments explain **why**, not what. Match the density and register of the
  file you're editing.

## Before you push

```bash
pnpm lint && pnpm typecheck && pnpm format:check
pnpm docs:check
pnpm test
(cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets && cargo fmt --check)
```

## Commit / PR conventions

- Small, reviewable commits with imperative subjects ("bound reason fields",
  not "bounded" / "misc fixes").
- PRs describe the user-visible behavior change first, implementation second,
  and name the tests that cover it.
