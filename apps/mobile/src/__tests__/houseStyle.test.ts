/*
 * `require`, not `import ... from 'node:fs'`. This package's tsconfig sets
 * `types: ["react-native", "jest"]` and `@types/node` is not resolvable from
 * here, so the import would not typecheck. Adding a types package to a React
 * Native app for one test that reads its own source is a worse trade than
 * naming the three functions it uses.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const { readdirSync, readFileSync, statSync } = require('fs') as {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { isDirectory(): boolean };
};
const join = (...parts: string[]) => parts.join('/');

/**
 * House style for every string a customer reads on the phone.
 *
 * Read as source, not rendered: what is being defended is "every screen", not
 * the branches some test happens to drive.
 *
 * **No em dashes in copy.** They were this app's default joint, and a reader
 * clocks that rhythm long before they can name it. Each is now a full stop, a
 * comma, a colon or a bracket, chosen sentence by sentence. Code COMMENTS are
 * exempt and deliberately so: they are prose for whoever maintains this.
 *
 * **No emoji.** They are drawn by whichever font the OS ships, in that font's
 * own colours, so they never matched a palette the rest of the app takes from
 * design tokens; they sit on the text baseline rather than an icon grid; and
 * VoiceOver announces them by their Unicode names ("laptop computer",
 * "penguin", "heavy multiplication x"), which described none of the things they
 * were being used for. `components/Glyph.tsx` draws the ones this app needs.
 */
// `__dirname` is not typed here either (see the require note above), and jest
// runs this file from the package root, so the relative path is enough.
const ROOT = 'src';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

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

const files = walk(ROOT).map((path) => ({
  name: path.slice(ROOT.length + 1),
  src: copyOnly(readFileSync(path, 'utf8')),
}));

describe('house style', () => {
  it('finds the files it means to check', () => {
    // A rename that emptied this list would turn the assertions below into
    // tests that pass by checking nothing.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files.map((f) => [f.name, f.src]))(
    '%s joins its sentences with punctuation, not em dashes',
    (_name, src) => {
      const offenders = src
        .split('\n')
        .map((line, i) => [i + 1, line.trim()] as const)
        .filter(([, line]) => line.includes('—'));
      expect(offenders.map(([n, l]) => `${n}: ${l}`)).toEqual([]);
    },
  );

  /**
   * Pictographs only. Arrows and the modifier-key symbols are DELIBERATELY
   * allowed: `⇧` is what Apple prints on a Shift key and in every macOS menu,
   * and `←↑↓→` are the arrow keys the viewer's key row sends. They render in
   * the text font, at the text weight, and spelling them out would make that
   * row less recognisable, not more. The rule is about glyphs the OS hands to
   * an emoji font, which is a different range.
   */
  it.each(files.map((f) => [f.name, f.src]))(
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
