export {};

declare const __dirname: string;
declare const require: (m: 'fs') => {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
};

/**
 * Two qualities that no unit test can hold, because they are properties of
 * every screen rather than of any one function: what the app says when it
 * fails, and whether its controls can be operated without looking at them.
 *
 * Both were measured before being fixed, on 2026-08-24:
 *
 *   44 interactive elements across the app, 6 accessibility props.
 *   5 of 6 screens with a button had NONE.
 *
 * A `<Pressable>` whose only child is a glyph ("⌨", "⌃") or an
 * `ActivityIndicator` has no spoken name at all — VoiceOver announces an
 * unlabelled button, or nothing. That is not a rough edge; it is a control a
 * blind user cannot find, and App Review has rejected apps for less.
 *
 * These read the screens as text on purpose. Rendering each one would need a
 * navigator, a camera mock and a WebRTC mock per screen, and would still only
 * cover the paths a test happens to drive — while the property being defended
 * is "every interactive element", which is exactly what a source scan can see
 * and a render test cannot.
 */

const SCREENS = `${__dirname}/../../screens`;

function screenSources(): Array<{ name: string; src: string }> {
  return require('fs')
    .readdirSync(SCREENS)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((name) => ({
      name,
      src: require('fs').readFileSync(`${SCREENS}/${name}`, 'utf8'),
    }));
}

describe('every screen can be operated without seeing it', () => {
  const screens = screenSources();

  it('finds the screens it means to check', () => {
    // A rename that silently emptied this list would turn every assertion
    // below into a test that passes by checking nothing.
    expect(screens.length).toBeGreaterThanOrEqual(5);
  });

  it.each(screens.map((s) => [s.name, s.src] as const))('%s labels its controls', (_name, src) => {
    const pressables = src.match(/<Pressable\b/g)?.length ?? 0;
    if (pressables === 0) return; // a screen with no controls has nothing to label
    const roles = src.match(/accessibilityRole=/g)?.length ?? 0;
    // Not one-to-one: a Pressable whose visible child is already a plain
    // sentence of text is legible to VoiceOver without an explicit label.
    // A screen with NO roles at all is the failure this pins — that was the
    // state of five of the six.
    expect(roles).toBeGreaterThan(0);
  });

  /**
   * The specific controls whose visible content is not words. These are the
   * ones that were completely silent, and the ones most likely to lose their
   * label in a future edit, because the label is the only thing carrying them.
   */
  it.each([
    ['keyboard-toggle', 'ViewerScreen.tsx'],
    ['tray-handle', 'ViewerScreen.tsx'],
    ['quality-badge', 'ViewerScreen.tsx'],
  ])('%s has a spoken name, not just a glyph', (testId, file) => {
    const src = screens.find((s) => s.name === file)?.src ?? '';
    // Split on the tag rather than regexing to the next ">": an arrow function
    // in a prop (`onPress={() => …}`) contains one, so a non-greedy match ends
    // before the attributes that matter whenever testID comes first.
    const el = src
      .split('<Pressable')
      .map((chunk) => `<Pressable${chunk.split('</Pressable>')[0] ?? ''}`)
      .find((chunk) => chunk.includes(`testID="${testId}"`));
    // jest's `expect` takes one argument (the two-arg form is vitest), so the
    // identifying detail goes in the assertion itself.
    expect({ testId, file, found: el !== undefined }).toEqual({ testId, file, found: true });
    expect(el!).toMatch(/accessibilityLabel=/);
    expect(el!).toMatch(/accessibilityRole="button"/);
  });
});

/**
 * What the app says when something goes wrong.
 *
 * `Could not load your devices (HTTP 503).` names the one thing a person can
 * do nothing about and none of the things they can. Every such string is now
 * routed through a function that maps the status to a remedy — and the point
 * of this test is that the next one added is caught before a customer reads
 * it.
 */
describe('failures are explained, not numbered', () => {
  const LIB = `${__dirname}/..`;

  it('never interpolates a status code into a message', () => {
    const offenders: string[] = [];
    for (const name of require('fs').readdirSync(LIB)) {
      if (!name.endsWith('.ts') || name.includes('.test.')) continue;
      const src = require('fs').readFileSync(`${LIB}/${name}`, 'utf8');
      for (const line of src.split('\n')) {
        // Comments discuss the old strings on purpose, including this file's
        // own history — only live code counts.
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) continue;
        if (/HTTP \$\{/.test(code)) offenders.push(`${name}: ${code.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Touch targets, against Apple's 44x44pt minimum (HIG, "Buttons").
 *
 * Measured 2026-08-24. The worst offenders were not decorative: "Remove" on
 * "Your devices" is a bare 14pt `Text` with no padding at all — roughly a 17pt
 * tall target on a DESTRUCTIVE action — and the viewer's tray handle is
 * exactly 40x40 while floating over video in landscape, which is the hardest
 * place on the screen to hit anything.
 *
 * `hitSlop` is the fix rather than padding because the tap area has to grow
 * without moving a single pixel of the layout.
 */
describe('small controls are still reachable with a thumb', () => {
  const SCREENS = `${__dirname}/../../screens`;
  const read = (f: string): string => require('fs').readFileSync(`${SCREENS}/${f}`, 'utf8');

  const tiny: Array<[file: string, marker: string]> = [
    // Bare `styles.action` text, no padding.
    ['AccountDevicesScreen.tsx', 'Rename ${item.name'],
    ['AccountDevicesScreen.tsx', 'Remove ${item.name'],
    // 14pt text, 10pt padding: ~37pt.
    ['DeviceListScreen.tsx', 'Forget ${item.name'],
    // Exactly 40x40.
    ['ViewerScreen.tsx', "'Hide controls' : 'Show controls'"],
  ];

  it.each(tiny)('%s — the control near %s carries hitSlop', (file, marker) => {
    const chunk = read(file)
      .split('<Pressable')
      .map((c) => c.split('</Pressable>')[0] ?? '')
      .find((c) => c.includes(marker));
    expect({ marker, found: chunk !== undefined }).toEqual({ marker, found: true });
    expect(chunk!).toMatch(/hitSlop=/);
  });
});
