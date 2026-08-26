import React from 'react';
import { View, StyleSheet } from 'react-native';
import { theme } from '../theme';

/**
 * The phone's icons, drawn rather than borrowed.
 *
 * These were emoji: a laptop, a phone, an Apple logo, a Windows pane, a
 * penguin, and a set of dingbats for the assistant's run states. Four problems,
 * and only the first is cosmetic.
 *
 * An emoji is drawn by whichever font the OS ships, in that font's own colours,
 * so it never matched a palette the rest of this app takes from design tokens,
 * and it changed shape between iOS versions. It sits on the text baseline at
 * whatever size the font decides, so it never lined up with the label beside
 * it. VoiceOver announces it by its Unicode name ("laptop computer", "penguin",
 * "heavy multiplication x"), which is not what any of them meant. And the
 * platform ones were decoration on a row that already spelled out the platform
 * in words.
 *
 * Drawn from `View` primitives, deliberately: `react-native-svg` is a native
 * dependency, a pod install and a new build, for a handful of small shapes that
 * borders and border radii already describe. Each takes a `color`, so a
 * caller's state colour reaches it.
 *
 * All are hidden from VoiceOver: each sits beside real text that says the
 * thing already.
 */

type GlyphProps = {
  /** Height in points. Widths derive from it, so the proportions hold. */
  size?: number;
  color?: string;
};

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants' as const,
};

/** A laptop: a lid above a base slightly wider than it. */
export function LaptopGlyph({ size = 22, color = theme.muted }: GlyphProps) {
  const lidW = size * 1.3;
  return (
    <View style={[styles.center, { height: size, width: lidW * 1.15 }]} {...hidden}>
      <View
        style={{
          width: lidW,
          height: size * 0.72,
          borderWidth: 1.6,
          borderColor: color,
          borderRadius: 3,
        }}
      />
      <View
        style={{
          width: lidW * 1.15,
          height: 1.6,
          backgroundColor: color,
          borderRadius: 1,
          marginTop: size * 0.1,
        }}
      />
    </View>
  );
}

/** A phone: a tall rounded rect with a speaker slot. */
export function PhoneGlyph({ size = 22, color = theme.muted }: GlyphProps) {
  return (
    <View style={[styles.center, { height: size, width: size * 0.72 }]} {...hidden}>
      <View
        style={{
          width: size * 0.62,
          height: size,
          borderWidth: 1.6,
          borderColor: color,
          borderRadius: 4,
          alignItems: 'center',
          paddingTop: size * 0.11,
        }}
      >
        <View
          style={{ width: size * 0.22, height: 1.6, backgroundColor: color, borderRadius: 1 }}
        />
      </View>
    </View>
  );
}

/**
 * A tick, as the corner of a box rotated 45 degrees.
 *
 * Two borders on one view rather than two rotated bars: a single corner cannot
 * drift out of alignment the way two independently-positioned bars can.
 */
export function CheckGlyph({ size = 14, color = theme.accent }: GlyphProps) {
  return (
    <View
      style={[styles.center, { width: size, height: size, transform: [{ rotate: '45deg' }] }]}
      {...hidden}
    >
      <View
        style={{
          width: size * 0.42,
          height: size * 0.8,
          borderRightWidth: 2,
          borderBottomWidth: 2,
          borderColor: color,
          marginTop: -size * 0.12,
        }}
      />
    </View>
  );
}

/** A cross, as two bars at right angles. */
export function CrossGlyph({ size = 14, color = theme.danger }: GlyphProps) {
  return (
    <View style={[styles.center, { width: size, height: size }]} {...hidden}>
      <View style={[styles.barA, { width: size * 0.9, backgroundColor: color }]} />
      <View style={[styles.barB, { width: size * 0.9, backgroundColor: color }]} />
    </View>
  );
}

/** Paused: two upright bars. */
export function PauseGlyph({ size = 12, color = theme.pending }: GlyphProps) {
  const w = size * 0.28;
  return (
    <View style={[styles.row, { height: size, gap: w * 0.8 }]} {...hidden}>
      <View style={{ width: w, height: size, backgroundColor: color, borderRadius: 1 }} />
      <View style={{ width: w, height: size, backgroundColor: color, borderRadius: 1 }} />
    </View>
  );
}

/** Running: a solid dot. A triangle at this size reads as a smudge. */
export function RunningGlyph({ size = 10, color = theme.accent }: GlyphProps) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
      {...hidden}
    />
  );
}

/** Nothing has happened yet: a hollow dot, so the row keeps its rhythm. */
export function IdleGlyph({ size = 8, color = theme.line }: GlyphProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.5,
        borderColor: color,
      }}
      {...hidden}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  barA: { height: 2, borderRadius: 1, position: 'absolute', transform: [{ rotate: '45deg' }] },
  barB: { height: 2, borderRadius: 1, position: 'absolute', transform: [{ rotate: '-45deg' }] },
});
