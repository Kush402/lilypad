import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Two properties of every screen at once, which is why they are read as source
 * rather than rendered: rendering each component would need its own Tauri
 * mocks and would still only cover the branches a test happens to drive, while
 * what is being defended here is "every field, on every screen".
 *
 * Measured 2026-08-25: nine `<input>`s in the desktop app and not one had a
 * label or an `aria-label` — the sign-in form, the password, the reset code,
 * the AI provider's API key, and the type-your-email box that confirms
 * deleting an account. A placeholder is not a label: it is announced
 * inconsistently across browsers and it disappears the moment there is a
 * value, so a half-filled form cannot be re-read at all (WCAG 3.3.2, 4.1.2).
 */
// `process.cwd()`, not `import.meta.url`: this suite runs under jsdom, where
// the module URL is an http:// one and `fileURLToPath` refuses it. Vitest runs
// with the package as its root.
const DIR = resolve(process.cwd(), 'src/components');

const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((name) => ({ name, src: readFileSync(`${DIR}/${name}`, 'utf8') }));

describe('every input says what it is', () => {
  it('finds the components it means to check', () => {
    // A rename that emptied this list would turn the assertion below into a
    // test that passes by checking nothing.
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it.each(sources.map((s) => [s.name, s.src] as const))('%s', (_name, src) => {
    const unnamed = src
      .split('<input')
      .slice(1)
      .map((chunk) => chunk.split('/>')[0] ?? '')
      .filter((chunk) => chunk.includes('placeholder'))
      // Either form of name counts: an `aria-label`, or an `id` a <label>
      // points at. The `id` test is a regex on purpose — `includes('id=')` is
      // satisfied by `data-testid=`, which every input here has, so it passed
      // every component while naming none of them.
      .filter((chunk) => !chunk.includes('aria-label') && !/\sid="/.test(chunk))
      .map((chunk) => chunk.match(/data-testid="([^"]+)"/)?.[1] ?? '(no testid)');
    expect(unnamed).toEqual([]);
  });
});
