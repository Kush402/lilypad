/**
 * @lilypad/design — one source of truth for Lilypad's visual language.
 *
 * TypeScript consumers (mobile) import from here. Web consumers (desktop,
 * admin) `@import '@lilypad/design/tokens.css'` instead and read the same
 * values as CSS custom properties; a test keeps the two in step.
 */
export * from './tokens.js';
