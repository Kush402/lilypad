import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { light, dark, radius, fontSans } from './tokens.js';

/**
 * `tokens.css` is written by hand so that `vite dev` never has to build this
 * package before it can resolve a stylesheet. The cost of that choice is that
 * the CSS and the TypeScript can drift — which is the exact failure P3 exists
 * to end. This test is what pays that cost: it parses the shipped CSS and
 * fails if the two disagree in either direction.
 */

const css = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf8');

/** Custom properties inside the nth `:root { … }` block, keyed by TS-style name. */
function blockVars(index: number): Record<string, string> {
  const blocks = css.match(/:root\s*\{[^}]*\}/g) ?? [];
  const block = blocks[index];
  if (block === undefined) throw new Error(`tokens.css has no :root block at index ${index}`);
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const name = match[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[name] = match[2]!.trim();
  }
  return out;
}

const rootVars = blockVars(0);
const darkVars = blockVars(1);

describe('tokens.css agrees with tokens.ts', () => {
  it('declares every light colour, byte for byte', () => {
    for (const [name, value] of Object.entries(light)) {
      expect(rootVars[name], `--${name} in :root`).toBe(value);
    }
  });

  // The dark block overrides only what differs, so a token missing from it
  // must genuinely be identical in both schemes. Anything else would silently
  // ship a light-scheme colour to a dark-scheme surface.
  it('overrides exactly the colours that differ in dark', () => {
    for (const [name, value] of Object.entries(dark)) {
      const declared = darkVars[name] ?? rootVars[name];
      expect(declared, `--${name} under prefers-color-scheme: dark`).toBe(value);
    }
    for (const name of Object.keys(darkVars)) {
      expect(
        dark[name as keyof typeof dark],
        `--${name} is overridden but not scheme-dependent`,
      ).not.toBe(light[name as keyof typeof light]);
    }
  });

  it('declares the radii and the font stack', () => {
    for (const [name, value] of Object.entries(radius)) {
      expect(rootVars[`radius${name[0]!.toUpperCase()}${name.slice(1)}`]).toBe(`${value}px`);
    }
    expect(rootVars.fontSans).toBe(fontSans);
  });

  // A property with no TypeScript counterpart is a colour mobile cannot see —
  // the drift this package exists to prevent, arriving from the CSS side.
  it('declares nothing the TypeScript does not', () => {
    const known = new Set([
      ...Object.keys(light),
      ...Object.keys(radius).map((k) => `radius${k[0]!.toUpperCase()}${k.slice(1)}`),
      'fontSans',
    ]);
    expect(Object.keys(rootVars).filter((n) => !known.has(n))).toEqual([]);
  });
});

describe('the palette itself', () => {
  // Both schemes must offer the same set of names, or a surface that switches
  // scheme loses a colour it was using.
  it('defines the same tokens in both schemes', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });
});
