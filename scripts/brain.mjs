#!/usr/bin/env node
/**
 * Lilypad brain keeper. Tool-agnostic pulse + hook adapter.
 * Fail open: never block the agent.
 *
 *   node scripts/brain.mjs pulse
 *   node scripts/brain.mjs sessionStart   # stdin = hook payload (Cursor or Claude Code)
 *   node scripts/brain.mjs stop
 *   node scripts/brain.mjs preCompact
 *   node scripts/brain.mjs sessionEnd
 *
 * Event may also come from stdin.hook_event_name (Claude Code).
 * stdout JSON includes both Cursor fields and Claude Code hookSpecificOutput.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT =
  process.env.CURSOR_PROJECT_DIR ||
  process.env.CLAUDE_PROJECT_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), '..');

const VAULT = join(ROOT, 'lilypad');
const ALIVE = join(VAULT, 'Alive.md');
const NOW = join(VAULT, 'Now.md');
const PENDING = join(VAULT, '.compact-pending');

function git(args) {
  try {
    return execSync(args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeEvent(raw) {
  const x = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '');
  if (x === 'sessionstart') return 'sessionStart';
  if (x === 'sessionend') return 'sessionEnd';
  if (x === 'precompact') return 'preCompact';
  if (x === 'stop' || x === 'stopfailure') return 'stop';
  if (x === 'pulse') return 'pulse';
  return x || 'pulse';
}

function pulse(extra = {}) {
  mkdirSync(VAULT, { recursive: true });
  const head = git('git log -1 --oneline') || '(no git)';
  const branch = git('git rev-parse --abbrev-ref HEAD') || '(unknown)';
  const dirty = git('git status -sb')
    .split('\n')
    .slice(1)
    .filter(Boolean);
  const compact = existsSync(PENDING);
  const when = stamp();
  const extraLines = Object.entries(extra)
    .filter(([, v]) => v)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');

  const body = `---
type: pulse
updated: ${when.slice(0, 10)}
---

# Alive

The keeper is on. This file is the heartbeat. Gitignored. Rewrite [[Now]] when the picture changes, not here.

- **beat:** \`${when}\`
- **branch:** \`${branch}\`
- **HEAD:** ${head}
- **dirty:** ${dirty.length === 0 ? 'clean' : dirty.length + ' paths'}
- **compact pending:** ${compact ? 'yes — next completed turn must rewrite Now' : 'no'}

${dirty.length ? dirty.map((l) => `  - \`${l.trim()}\``).join('\n') : ''}
${extraLines ? '\n' + extraLines + '\n' : ''}
[[Home]] · [[Now]] · [[How this vault works]]
`;

  writeFileSync(ALIVE, body);
  return { when, head, branch, dirty, compact };
}

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[truncated]\n';
}

const SAVE_MSG =
  'The conversation compacted or is about to. You own lilypad/. Read AGENTS.md, lilypad/Now.md, lilypad/Alive.md, and git status. Rewrite lilypad/Now.md if the picture of current work changed (replace, do not append). Write a session note under lilypad/sessions/ only if this turn learned something that is not already in Now or kanban. Delete lilypad/.compact-pending. Then stop. Do not commit. Do not touch docs/ unless the code already required it.';

try {
  const input = await stdinJson();
  const event = normalizeEvent(
    process.argv[2] || input.hook_event_name || input.hookEventName,
  );

  if (event === 'pulse' || event === 'sessionEnd') {
    pulse(
      event === 'sessionEnd'
        ? { session: input.reason || input.source || 'ended', duration_ms: input.duration_ms }
        : {},
    );
    out({});
    process.exit(0);
  }

  if (event === 'sessionStart') {
    const p = pulse({
      session: input.session_id,
      mode: input.composer_mode || input.source,
    });
    const now = read(NOW) || '(Now.md missing)';
    const context = [
      'You are the keeper of the Lilypad Obsidian vault at lilypad/. This is not optional. If working memory is not in the vault, it did not happen. Protocol: AGENTS.md.',
      'Canon is docs/ (CI). The vault is attention. Rewrite lilypad/Now.md when "current" changes. Proven defects go in docs/kanban.md. Never a second ledger. Never edit an accepted ADR in place.',
      'Read Now before acting on a non-trivial task. Heartbeat is lilypad/Alive.md (gitignored, rewritten every turn).',
      '',
      '## Now.md',
      clip(now, 6000),
      '',
      `## Pulse ${p.when}`,
      `HEAD ${p.head} · dirty ${p.dirty.length}`,
    ].join('\n');
    out({
      env: { LILYPAD_BRAIN: '1' },
      additional_context: context,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    });
    process.exit(0);
  }

  if (event === 'preCompact') {
    pulse({
      compact: `${input.trigger || input.source || 'auto'} at ${input.context_usage_percent ?? '?'}%`,
    });
    writeFileSync(
      PENDING,
      JSON.stringify(
        {
          at: stamp(),
          trigger: input.trigger || input.source,
          context_usage_percent: input.context_usage_percent,
          message_count: input.message_count,
        },
        null,
        2,
      ),
    );
    out({
      user_message:
        'Lilypad brain: snapshot in Alive.md. Next completed turn will rewrite Now.md so compaction cannot eat the working picture.',
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext:
          'Context is about to compact. Snapshot is in lilypad/Alive.md. Rewrite lilypad/Now.md this turn if the working picture changed, then delete lilypad/.compact-pending.',
      },
    });
    process.exit(0);
  }

  if (event === 'stop') {
    const p = pulse({ stop: input.status, loop_count: input.loop_count });
    const alreadyContinuing =
      Boolean(input.stop_hook_active) || Number(input.loop_count || 0) > 0;
    const aborted = input.status === 'aborted';
    if (p.compact && !alreadyContinuing && !aborted) {
      out({
        followup_message: SAVE_MSG,
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: SAVE_MSG,
        },
      });
    } else {
      out({});
    }
    process.exit(0);
  }

  pulse();
  out({});
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err?.stack || err) + '\n');
  out({});
  process.exit(0);
}
