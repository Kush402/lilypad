## What changed (user-visible behavior first)

## Why

## Tests

<!-- Name the tests that cover this change. New behavior requires new tests. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck` clean
- [ ] Backend `vitest run`, mobile `jest`, desktop `cargo test` all green
- [ ] `cargo clippy --all-targets` clean (if Rust touched)
- [ ] Protocol changes mirrored in the Rust types + drift test updated
- [ ] Docs updated if behavior, API, or env vars changed
