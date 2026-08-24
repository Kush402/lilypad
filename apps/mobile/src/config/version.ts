/**
 * This build's version, as a string the phone can send and a person can read
 * aloud.
 *
 * A constant rather than a read of `package.json`: the mobile `tsconfig`
 * includes only `src`, and widening it to reach a sibling file is a larger
 * change than one line that `pnpm release` rewrites. `scripts/release.mjs`
 * keeps this, `package.json`, `MARKETING_VERSION` and Gradle's `versionName`
 * in lockstep, and fails loudly if any of them has drifted — which they all
 * had, sitting at `1.0`/`0.1.0` while the desktop shipped 0.1.4.
 */
export const APP_VERSION = '0.1.7';
