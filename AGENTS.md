# Agent protocol — Lilypad brain

This file is the contract for **any** coding agent (Cursor, Claude Code, Codex, Copilot, Aider, Windsurf, Gemini CLI, …). Tool-specific loaders (`CLAUDE.md`, `CODEX.md`, `.cursor/rules/`, `.github/copilot-instructions.md`) exist only to point here. Do not delete the Cursor loader; dual-tool is the point.

**Codex:** you load this file natively. Before any work, read `lilypad/Now.md`. If it is missing, stop; do not invent it. Then continue this file. `CODEX.md` is the Codex-only loader (same role as `CLAUDE.md`); it does not replace this contract.

## Two layers

| Layer | Where      | Job                                                         |
| ----- | ---------- | ----------------------------------------------------------- |
| Canon | `docs/`    | What the system is. Frontmatter. `pnpm docs:check` in CI.   |
| Brain | `lilypad/` | Working memory. Open that **folder** as the Obsidian vault. |

If a fact must survive a compacted chat, it belongs in `docs/` (or `docs/kanban.md` for a pre-launch finding). The vault is attention, not a second README.

## You are the keeper

If it is not in the vault, it did not happen.

1. Before non-trivial work, read `lilypad/Now.md` (and `lilypad/Home.md` if you need the map). If `Now.md` is missing, the vault was not copied onto this machine — stop; do not invent it.
2. Rewrite `lilypad/Now.md` when “current” changes. Replace; do not append.
3. Proven defects → a new row in `docs/kanban.md`. No second ledger.
4. Working hypotheses / next actions → `lilypad/sessions/`.
5. Unsettled → `lilypad/questions/` with `type: question` and `status: open`.
6. Never edit an accepted ADR in place; supersede it.
7. Vault notes: wikilinks. `docs/`: relative markdown.

Heartbeat: `lilypad/Alive.md` (gitignored). Pulse with `node scripts/brain.mjs pulse` if your tool has no hooks.

## Do not reverse

- Invent product work that is not already in `docs/`, an ADR, or `docs/kanban.md`
- Flip `ENFORCE_REMOTE_ENTITLEMENT`
- Start a second backend replica until M11 (rooms and rate limits are in-process)
- Silent remote access; fail-open at a boundary; a one-off JSON shape outside `@lilypad/protocol`
- Desktop is the offerer; inbound RTP/input outvotes a dead FSM; presence liveness is `pong`

## Vault vs git

Notes under `lilypad/` are **not gitignored** (except `Alive.md`, Obsidian workspace, trash). They are **not tracked** today because sessions name testers. A fresh clone has the protocol files once those are committed; it does **not** have `Now.md` until you copy `lilypad/` from the machine that runs Obsidian.

## Hooks (optional)

Same script, two wrappers:

- Cursor: `.cursor/hooks.json` → `node scripts/brain.mjs …`
- Claude Code: `.claude/settings.json` → the same command
- Codex: no project hook; native file is this `AGENTS.md`; loader is `CODEX.md`. Still read `lilypad/Now.md` first.

If your tool cannot hook, the files still work: you read them.

How the vault is laid out: [[How this vault works]].
