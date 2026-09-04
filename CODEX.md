@AGENTS.md

# Codex

Same brain as Cursor and Claude Code. Vault: `lilypad/` (open that **folder** in Obsidian). Canon: `docs/`. Do not start a second memory, ledger, or product.

Codex natively loads root [`AGENTS.md`](AGENTS.md). This file is the Codex-only loader (same role as [`CLAUDE.md`](CLAUDE.md)). It is not a second protocol and not a dump of the vault.

## First

1. Read `lilypad/Now.md`. If it is missing, the vault was not copied onto this machine — stop and say so. Do not invent a Now from chat.
2. Read `AGENTS.md`.
3. Then only files the task needs (`docs/kanban.md` for defects / ship state; `docs/` for what the system is).

## Do not

- Invent work that is not already in `docs/`, an ADR, or `docs/kanban.md`
- Flip `ENFORCE_REMOTE_ENTITLEMENT`
- Start a second backend replica (in-process rooms until M11)
- Merge kitchen-sink PRs · edit an accepted ADR in place · start a second defect table · treat a chat summary as the record
- Commit secrets · force-push · skip hooks · commit unless asked
- Delete `.cursor/rules` — Cursor still shares this vault

## Session lifecycle (do not reverse)

- Desktop offers; phone answers
- Inbound RTP / input outvotes a `failed` ICE or FSM death; `peer-status` offline plus stale media ends the session
- Capture and input only after explicit desktop approval
- Presence liveness is `pong`, not inbound hub frames
- Fail closed at boundaries; `@lilypad/protocol` is the wire contract

## Vault on a clone

`lilypad/` is not gitignored (except `Alive.md`, Obsidian workspace, trash). It is **not tracked** today — session notes name testers. Codex sees `Now.md` only if the folder is on disk.

When switching machines: copy this repo’s `lilypad/` directory onto the new clone. Protocol files: `AGENTS.md`, this file, `CLAUDE.md`, `.claude/settings.json`, `.cursor/rules/`, `scripts/brain.mjs`. Copy the vault separately until notes are deliberately tracked.

Codex has no project hook. Pulse with `node scripts/brain.mjs pulse` if you want a heartbeat; rewrite `lilypad/Now.md` when current changes regardless.
