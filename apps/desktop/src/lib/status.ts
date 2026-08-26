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
  connecting: 'Connecting…',
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
  connecting: 'var(--pending)',
  active: 'var(--live)',
};

/** What the bubble's click will do in each state — used as both the native
 * `title` tooltip and the accessible `aria-label`, so a screen-reader user
 * gets the same accurate, state-dependent description a sighted user
 * hovering the bubble does (previously a static "Lilypad" label that never
 * changed, misleadingly implying "pair a phone" even mid-session). See
 * `docs/audit/m3/desktop-ux.md` Finding 14. */
export const STATUS_ARIA_LABEL: Record<SessionStatus, string> = {
  // Two of these described a bubble that no longer exists, and they are the
  // tooltip as well as the screen-reader name — so both audiences were told
  // the wrong thing. `idle` has opened the DASHBOARD since the QR stopped
  // being the front door, and `active` opens the dashboard too: the click
  // never disconnected anything, it showed you the window where Disconnect
  // lives. Promising a destructive action a click does not perform is the
  // worse half of that.
  idle: 'Lilypad. Click to open the dashboard',
  pairing: 'Lilypad. Waiting for a phone to scan. Click to reopen the pairing code',
  awaiting_approval: 'Lilypad. A phone wants to connect. Click to review',
  connecting: 'Lilypad. Connecting to a phone. Click to review',
  active: 'Lilypad. A phone is connected. Click to open the dashboard',
};
