/**
 * The product's icons, drawn rather than borrowed.
 *
 * Every one of these used to be an emoji or a dingbat glyph: a red "⛔" on the
 * Panic button, a "✓" on the setup-complete card, a "✕" on the update banner's
 * dismiss. Three problems with that, and the first is the one that shows.
 *
 * An emoji is drawn by whichever font the OS ships, so it carries its own
 * colours and its own shape. "⛔" is a red-and-white disc that sat on a red
 * button, so the icon fought the surface it was on; it also changed appearance
 * between macOS versions and matched nothing else in the product. Second, glyph
 * metrics are not icon metrics: they sit on the text baseline at whatever size
 * the font decides, which is why they never quite lined up with the label
 * beside them. Third, they are read aloud by screen readers as their Unicode
 * names ("no entry", "heavy check mark"), which is not what any of them meant.
 *
 * These are stroke-based on a 24px grid, sized in `em` so they scale with their
 * label, and painted with `currentColor` so a button's own colour reaches them.
 * All are `aria-hidden`: each sits beside real text that already says the thing.
 */

type IconProps = {
  /** Multiplier on the current font size. 1 matches the label beside it. */
  size?: number;
  className?: string;
};

function svgProps({ size = 1, className }: IconProps) {
  return {
    className: className ? `icon ${className}` : 'icon',
    viewBox: '0 0 24 24',
    width: `${size}em`,
    height: `${size}em`,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
  };
}

/** Panic. An octagon reads as "stop" without borrowing a road sign's colours. */
export function IconPanic(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

/** Done. */
export function IconCheck(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 12.5l5.5 5.5L20 6.5" />
    </svg>
  );
}

/** Dismiss. */
export function IconClose(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
