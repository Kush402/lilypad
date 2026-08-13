import { dark, radius } from '@lilypad/design';

/**
 * The mobile palette (P3). Previously seven hexes written out here, identical
 * to seven in the admin dashboard's stylesheet and seven more in the desktop's
 * dark block; now one import of the shared tokens
 * ([ADR-0011](../../../docs/adr/0011-design-tokens.md)).
 *
 * Mobile is dark-only — it renders full-bleed video and a light chrome around
 * a dark picture is worse, not merely different — so it takes the dark scheme
 * directly rather than following the OS.
 */
export const theme = dark;

export { radius };
