import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * House style for every string a customer reads on this Mac.
 *
 * Read as source, like `a11y.test.ts` and for the same reason: what is being
 * defended is "every screen", not the branches some test happens to drive.
 *
 * **No em dashes in copy.** They were this app's default joint, and a reader
 * clocks that rhythm long before they can name it. Each one is now a full
 * stop, a comma, a colon or a bracket, chosen sentence by sentence. Code
 * COMMENTS are exempt and deliberately so: they are prose for whoever
 * maintains this, not for a customer.
 *
 * **No emoji or dingbats.** They are drawn by whichever font the OS ships, so
 * they carry their own colours (a red "⛔" on a red button), sit on the text
 * baseline instead of the icon grid, change between macOS versions, and are
 * announced by screen readers as their Unicode names. `Icon.tsx` draws the
 * three this app needs.
 */
const DIR = resolve(process.cwd(), 'src/components');
const LIB = resolve(process.cwd(), 'src/lib');

/**
 * Comments stripped, so only string literals and JSX text remain. Trailing
 * comments count: `foo(); // note — here` is a note, not copy.
 *
 * The URL guard is why this is not a one-liner: `https://x` contains `//`.
 */
function copyOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .map((line) => {
      const at = line.search(/(^|[^:'"`\w])\/\//);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

const sources = [
  ...readdirSync(DIR).map((name) => ({ name: `components/${name}`, dir: DIR, file: name })),
  ...readdirSync(LIB).map((name) => ({ name: `lib/${name}`, dir: LIB, file: name })),
]
  .filter(({ file }) => /\.(tsx?|ts)$/.test(file) && !file.includes('.test.'))
  .map(({ name, dir, file }) => ({ name, src: copyOnly(readFileSync(`${dir}/${file}`, 'utf8')) }));

describe('house style', () => {
  it('finds the files it means to check', () => {
    // A rename that emptied this list would turn every assertion below into a
    // test that passes by checking nothing.
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  it.each(sources.map((s) => [s.name, s.src] as const))(
    '%s joins its sentences with punctuation, not em dashes',
    (_name, src) => {
      const offenders = src
        .split('\n')
        .map((line, i) => [i + 1, line.trim()] as const)
        .filter(([, line]) => line.includes('—'));
      expect(offenders.map(([n, l]) => `${n}: ${l}`)).toEqual([]);
    },
  );

  it.each(sources.map((s) => [s.name, s.src] as const))(
    // Pictographs only. Arrows and modifier-key symbols are deliberately
    // allowed: they render in the text font and are what the OS itself prints.
    '%s draws its icons instead of borrowing an emoji font',
    (_name, src) => {
      const offenders = src
        .split('\n')
        .map((line, i) => [i + 1, line.trim()] as const)
        .filter(([, line]) =>
          /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(line),
        );
      expect(offenders.map(([n, l]) => `${n}: ${l}`)).toEqual([]);
    },
  );
});
