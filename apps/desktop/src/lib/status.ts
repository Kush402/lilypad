import type { SessionStatus } from './tauri';

/**
 * Single source of truth for how `SessionStatus` is represented across every
 * surface (bubble, Control window) — previously `Bubble.tsx` and
 * `Control.tsx` each defined their own partial, independently-drifting copy
 * (colors only vs. labels only) for the same enum. See
 * `docs/audit/m3/desktop-ux.md` Finding 14.
 */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Idle',
  pairing: 'Waiting for scan',
  awaiting_approval: 'Approval requested',
  active: 'Session active',
};

/** `active` intentionally does NOT reuse `--danger` (the Deny/Panic button
 * color) — a live session is a neutral-to-expected state, not a destructive
 * one, and collapsing both into the same red blurs that distinction. See
 * `docs/audit/m3/desktop-ux.md` Finding 16. */
export const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: 'var(--accent)',
  pairing: 'var(--pending)',
  awaiting_approval: 'var(--pending)',
  active: 'var(--live)',
};

/** What the bubble's click will do in each state — used as both the native
 * `title` tooltip and the accessible `aria-label`, so a screen-reader user
 * gets the same accurate, state-dependent description a sighted user
 * hovering the bubble does (previously a static "Lilypad" label that never
 * changed, misleadingly implying "pair a phone" even mid-session). See
 * `docs/audit/m3/desktop-ux.md` Finding 14. */
export const STATUS_ARIA_LABEL: Record<SessionStatus, string> = {
  idle: 'Lilypad — click to show a pairing QR code',
  pairing: 'Lilypad — waiting for a phone to scan, click to reopen the QR code',
  awaiting_approval: 'Lilypad — a phone wants to connect, click to review',
  active: 'Lilypad — session active, click to disconnect',
};
