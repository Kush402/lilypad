/**
 * Design tokens — the single source of truth for Lilypad's visual language
 * (P3, [ADR-0011](../../../docs/adr/0011-design-tokens.md)).
 *
 * Before this, the palette existed three times: `apps/mobile/src/theme.ts`,
 * `apps/admin/src/styles.css`, and the dark half of `apps/desktop/src/styles.css`.
 * Three copies of the same seven hexes is not a style choice, it is three
 * chances to drift — and it already had, in four places:
 *
 * - `#06231a` (text on an accent button) was written out eight times across
 *   five files, plus once as `#04140d` in the agent panel.
 * - "waiting on a human" was `#e0a83e` on mobile and `#f5a623` in the quality
 *   meter, while the desktop already called that state `--pending`.
 * - The desktop's status dots used Apple's system green and amber (`#34c759`,
 *   `#ff9f0a`) — a second green and a second amber for a meaning the palette
 *   already had a colour for.
 * - `SignInScreen` was on no palette at all: white buttons, `#ccc` borders and
 *   a Material red on a product that is dark green everywhere else.
 *
 * ## What is shared, and what deliberately is not
 *
 * **Colour is shared** across all three surfaces, because a colour means the
 * same thing on a phone as on a laptop and drift is immediately visible.
 *
 * **Font sizes are not.** The web surfaces are hand-tuned around 11–18px and
 * mobile around 13–26pt, because a phone is held at arm's length and a laptop
 * is not. One shared numeric scale would have to move one of them, which is a
 * redesign rather than a de-duplication. Sizes therefore stay in each
 * surface's own stylesheet; the font *family*, which really was duplicated
 * verbatim, lives here.
 *
 * Every value below is harvested from what already shipped. Nothing here is a
 * new colour.
 */

/**
 * Foreground colours for the two filled buttons. Scheme-independent on
 * purpose: a filled accent button is the same green in both schemes, so its
 * text does not change either — this is what the desktop already did with a
 * single `.btn--primary` rule serving light and dark.
 */
const fixed = {
  /** Text/icon on an `accent` fill. */
  onAccent: '#06231a',
  /** Text/icon on a `danger` fill. */
  onDanger: '#2a0808',
} as const;

/** Light — the desktop's default scheme. */
export const light = {
  ...fixed,
  bg: '#f4faf7',
  panel: '#ffffff',
  ink: '#10201a',
  muted: '#4d6b60',
  accent: '#1f9f6b',
  danger: '#d92626',
  /**
   * A session is being observed right now. Deliberately distinct from
   * `danger` even though both are reddish: conflating "you are being watched"
   * with "this button destroys something" was audit finding 16's complaint.
   */
  live: '#ff7847',
  /** Waiting on a human — approval pending, degraded link, holding. */
  pending: '#b8720a',
  line: '#d8e6df',
  /**
   * A translucent accent tint (chips, wash backgrounds). Its own token rather
   * than a computed alpha of `accent`: the two schemes' accents differ enough
   * in lightness that one fixed alpha does not read well against both.
   */
  accentWash: 'rgba(31, 159, 107, 0.12)',
  /**
   * `accent` at text size, on a light background.
   *
   * `accent` is 3.19:1 against `bg` — enough for a border, an icon or large
   * text, and NOT enough for body copy, which WCAG AA puts at 4.5:1. Every
   * link on the website was that colour, including the download link. This is
   * the same hue (155.6deg) and saturation, darkened until it clears 4.5:1
   * against `bg`, `panel` and `accentWash` alike.
   *
   * Dark needs no such split: its accent is already 9.27:1, so `accentInk`
   * there is the accent itself.
   */
  accentInk: '#187b53',
} as const;

/** Dark — what mobile and the admin dashboard ship, and the desktop's `prefers-color-scheme: dark`. */
export const dark = {
  ...fixed,
  bg: '#0e1512',
  panel: '#16211c',
  ink: '#e8f5ee',
  muted: '#8fb3a3',
  accent: '#3ecf8e',
  danger: '#ff5c5c',
  live: '#ff8f5c',
  pending: '#f5a623',
  line: '#24352d',
  accentWash: 'rgba(62, 207, 142, 0.15)',
  accentInk: '#3ecf8e',
} as const;

/**
 * Corner radii, in px — the five distinct values the surfaces already used,
 * named rather than reduced. Trimming them to three would have re-cornered
 * roughly a dozen shipped components for no reason beyond tidiness.
 *
 * A perfect circle (`border-radius: 50%`) is not in here: that is a shape, not
 * a step on this scale, and it does not change if the scale does.
 */
export const radius = {
  /** Inline chrome — pills inside a row, small tiles. */
  xs: 8,
  /** Buttons, inputs. */
  sm: 10,
  /** Grouped controls, secondary panels. */
  md: 12,
  /** Cards, framed content. */
  lg: 14,
  /** Fully rounded — tags, capsules. */
  pill: 999,
} as const;

/**
 * The system font stack, previously written out identically in two
 * stylesheets. Mobile is absent on purpose: React Native already resolves the
 * platform's system face, and naming families there would override it.
 */
export const fontSans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" as const;

export type ColorScheme = typeof light;
export type ColorName = keyof ColorScheme;
