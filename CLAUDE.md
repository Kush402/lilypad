@AGENTS.md

# Claude Code / Codex

Same brain as Cursor. Vault: `lilypad/` (open that **folder** in Obsidian). Canon: `docs/`. Do not start a second memory, ledger, or product.

## First

1. Read `AGENTS.md`.
2. Read `lilypad/Now.md`. If it is missing, the vault was not copied onto this machine — stop and say so. Do not invent a Now from chat.
3. Then `docs/` for what the system is.

## Do not

- Invent work that is not already in `docs/`, an ADR, or `docs/kanban.md`
- Flip `ENFORCE_REMOTE_ENTITLEMENT`
- Start a second backend replica (in-process rooms until M11)
- Edit an accepted ADR in place · start a second defect table · treat a chat summary as the record
- Delete `.cursor/rules` — Cursor still shares this vault

## Session lifecycle (do not reverse)

- Desktop offers; phone answers
- Inbound RTP / input outvotes a `failed` ICE or FSM death; `peer-status` offline plus stale media ends the session
- Capture and input only after explicit desktop approval
- Presence liveness is `pong`, not inbound hub frames
- Fail closed at boundaries; `@lilypad/protocol` is the wire contract

## Vault on a clone

`lilypad/` is not gitignored (except `Alive.md`, Obsidian workspace, trash). It is **not tracked** today — session notes name testers. Claude Code and Codex see it only if the folder is on disk.

When switching machines: copy this repo’s `lilypad/` directory onto the new clone. Commit `AGENTS.md`, this file, `CODEX.md`, `.claude/settings.json`, `.cursor/rules/`, and `scripts/brain.mjs`. Copy the vault separately until notes are deliberately tracked.

Codex reads `AGENTS.md` natively; its loader is `CODEX.md` (Now.md first). Claude Code reads this file. Same protocol, same vault.
