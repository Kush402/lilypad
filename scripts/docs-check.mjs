#!/usr/bin/env node
/**
 * `pnpm docs:check` — treat documentation drift as a build failure.
 *
 * This repo has already shipped features whose docs said "not started", and
 * routes that existed in code but nowhere in `docs/api.md`. Every check here
 * exists because that specific failure actually happened.
 *
 * Checks:
 *   1. frontmatter  Every docs/**\/*.md declares status + owner + last-verified.
 *   2. links        Every relative markdown link resolves to a real file.
 *   3. routes       Every HTTP route registered in the backend appears in
 *                   docs/api.md, and vice versa.
 *
 * Dependency-free (matches doctor.mjs / bootstrap.mjs / clean.mjs house style):
 * the frontmatter parser handles the flat `key: value` subset we actually use.
 *
 * ponytail: a route-inventory diff, not generated OpenAPI. It catches the drift
 * we actually hit while keeping api.md's hand-written rationale (why an error is
 * shaped a certain way) that codegen would flatten. Move to generated OpenAPI
 * when the surface outgrows a table, or when a third party consumes the API.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Allowed `status:` values. Every doc must declare exactly one. */
const STATUSES = [
  'Implemented', // describes what the code does today
  'In Progress', // partially built; the doc leads the code
  'Planned', // design only, nothing built
  'Experimental', // built but not committed to
  'Deprecated', // still true, on the way out
  'Superseded', // replaced; kept for history, points at its replacement
  'Reference', // historical record (audits, ADRs) — cited, never "current"
];

/** Directories scanned for docs requiring frontmatter. */
const FRONTMATTER_ROOTS = ['docs'];

/**
 * Files exempt from the frontmatter rule. GitHub renders these as the repo's
 * front door or as issue-template metadata; a YAML block would either show up
 * as noise or collide with the template's own frontmatter.
 */
const FRONTMATTER_EXEMPT = new Set(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']);

const problems = [];
const fail = (file, message) => problems.push({ file, message });

// ── file walking ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.turbo',
  'Pods',
  'vendor', // apps/mobile/vendor/bundle — gems, same category as node_modules
  '.gradle',
  '.codegraph',
  '.code-review-graph',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// ── 1. frontmatter ──────────────────────────────────────────────────────────

/** Parse the flat `key: value` frontmatter block. Returns null when absent. */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const fields = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function checkFrontmatter(files) {
  for (const file of files) {
    const rel = relative(ROOT, file);
    const inScope = FRONTMATTER_ROOTS.some((d) => rel === d || rel.startsWith(`${d}/`));
    if (!inScope) continue;
    if (FRONTMATTER_EXEMPT.has(rel)) continue;

    const meta = parseFrontmatter(readFileSync(file, 'utf8'));
    if (!meta) {
      fail(rel, 'missing frontmatter block (need status, owner, last-verified)');
      continue;
    }
    for (const key of ['status', 'owner', 'last-verified']) {
      if (!meta[key]) fail(rel, `frontmatter missing \`${key}\``);
    }
    if (meta.status && !STATUSES.includes(meta.status)) {
      fail(rel, `status "${meta.status}" is not one of: ${STATUSES.join(', ')}`);
    }
    if (meta['last-verified'] && !/^\d{4}-\d{2}-\d{2}$/.test(meta['last-verified'])) {
      fail(rel, `last-verified "${meta['last-verified']}" is not YYYY-MM-DD`);
    }
  }
}

// ── 2. links ────────────────────────────────────────────────────────────────

/** `[text](target)` — skipping external, anchor-only, and mailto targets. */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(files) {
  for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    for (const [, target] of text.matchAll(LINK_RE)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [path] = target.split('#');
      if (!path) continue;
      if (!existsSync(resolve(dirname(file), path))) {
        fail(rel, `broken link → ${target}`);
      }
    }
  }
}

// ── 3. API route drift ──────────────────────────────────────────────────────

const ROUTES_DIR = join(ROOT, 'apps/backend/src/routes');
const API_DOC = join(ROOT, 'docs/api.md');

/** `app.get('/health'` / `app.post(\n  '/devices/unpair',` → METHOD /path */
const ROUTE_RE = /\bapp\.(get|post|patch|put|delete)\(\s*\n?\s*['"`]([^'"`]+)['"`]/g;
/** The signaling socket registers via the shared SIGNALING_PATH constant. */
const WS_ROUTE_RE = /\bapp\.get\(\s*SIGNALING_PATH\b/;

function registeredRoutes() {
  const found = new Set();
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const text = readFileSync(join(ROUTES_DIR, entry), 'utf8');
    for (const [, method, path] of text.matchAll(ROUTE_RE)) {
      found.add(`${method.toUpperCase()} ${path}`);
    }
    if (WS_ROUTE_RE.test(text)) found.add('GET /ws/signal');
  }
  return found;
}

const ROUTE_MENTION_RE = /\b(GET|POST|PATCH|PUT|DELETE)\s+(\/[A-Za-z0-9/_:.*-]*)/g;

/**
 * Routes named in api.md, split by whether their section is marked as shipped.
 * The doc's own legend is the source of truth: a `🔜` in the enclosing heading
 * means "later milestone", so those are expected to be absent from the code.
 */
function documentedRoutes(text) {
  const shipped = new Set();
  const planned = new Set();
  let plannedSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) plannedSection = line.includes('🔜');
    for (const [, method, path] of line.matchAll(ROUTE_MENTION_RE)) {
      const route = `${method} ${path.replace(/[.,]$/, '')}`;
      (plannedSection ? planned : shipped).add(route);
    }
  }
  return { shipped, planned };
}

function checkRoutes() {
  if (!existsSync(ROUTES_DIR) || !existsSync(API_DOC)) return;
  const registered = registeredRoutes();
  const { shipped, planned } = documentedRoutes(readFileSync(API_DOC, 'utf8'));
  // Compare ignoring any query string a doc shows for readability.
  const base = (route) => route.split('?')[0];
  const shippedBases = new Set([...shipped].map(base));

  for (const route of registered) {
    if (!shippedBases.has(route)) {
      fail('docs/api.md', `route registered in code but not documented: ${route}`);
    }
  }
  for (const route of shipped) {
    if (!registered.has(base(route))) {
      fail('docs/api.md', `route documented as shipped but not registered in code: ${route}`);
    }
  }
  for (const route of planned) {
    if (registered.has(base(route))) {
      fail('docs/api.md', `route marked 🔜 (planned) but IS registered in code: ${route}`);
    }
  }
}

/**
 * docs/kanban.md's header claims to be "counted from the rows rather than kept
 * by hand". It was not — adding four rows left the total reading 89 while the
 * table held 93, which is the exact drift the header was written to complain
 * about. A tally nobody recomputes is worse than no tally: it is read as fact.
 */
function checkKanbanTally() {
  const file = 'docs/kanban.md';
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return; // the file is optional; checkLinks already reports a missing target
  }
  const header = /\*\*Status counts:\*\*([\s\S]*?)rows\./.exec(text);
  if (!header) return fail(file, 'no "**Status counts:** … rows." header to check');

  // Each row is `| L-nn | finding | status |`; the status is the last cell.
  const counts = new Map();
  let total = 0;
  for (const [, , rest] of text.matchAll(/^\|\s*(L-\d+)\s*\|(.*)\|\s*$/gm)) {
    total += 1;
    const status = rest.slice(rest.lastIndexOf('|') + 1);
    // "Fixed — …", "**Blocked** — …", "Open — …": the first word, unstyled.
    const word = status
      .replace(/\*/g, '')
      .trim()
      .split(/[\s—-]/)[0]
      .toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const claimed = Number(/(\d+)\s+rows\./.exec(header[0])?.[1]);
  if (claimed !== total) fail(file, `header says ${claimed} rows; the table has ${total}`);

  for (const [word, n] of counts) {
    // Only the words the header actually names are checked — a new status word
    // should fail loudly by being absent, not silently by being ignored.
    const claim = new RegExp(`(\\d+)\\s+${word}\\b`, 'i').exec(header[1]);
    if (!claim) fail(file, `${n} row(s) are "${word}" and the header does not mention it`);
    else if (Number(claim[1]) !== n)
      fail(file, `header says ${claim[1]} ${word}; the table has ${n}`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const files = walk(ROOT);
checkFrontmatter(files);
checkLinks(files);
checkRoutes();
checkKanbanTally();

if (problems.length === 0) {
  console.log(`docs-check: OK (${files.length} markdown files)`);
  process.exit(0);
}

console.error(`docs-check: ${problems.length} problem(s)\n`);
const byFile = new Map();
for (const { file, message } of problems) {
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(message);
}
for (const [file, messages] of [...byFile].sort()) {
  console.error(`  ${file}`);
  for (const message of messages) console.error(`    - ${message}`);
}
console.error('');
process.exit(1);
