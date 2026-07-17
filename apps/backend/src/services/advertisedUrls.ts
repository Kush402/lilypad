import { env } from '../config.js';

/**
 * The URLs pairing responses advertise to clients (QR payload + redeem).
 *
 * Normally these come straight from env (pinned in production, LAN-auto-
 * detected in dev). A quick tunnel (`tunnel/quickTunnel.ts`) comes up
 * AFTER boot and hands out an ephemeral public URL — this tiny module is the
 * mutable seam between "configured at boot" and "discovered at runtime",
 * so the pairing service never has to know which mode it's in.
 */

export interface AdvertisedUrls {
  apiBaseUrl: string;
  signalingUrl: string;
}

let override: AdvertisedUrls | null = null;

export function advertisedUrls(): AdvertisedUrls {
  return override ?? { apiBaseUrl: env.PUBLIC_BASE_URL, signalingUrl: env.SIGNALING_URL };
}

/** Set (or with `null`, clear) the runtime override — tunnel up/down. */
export function setAdvertisedUrls(next: AdvertisedUrls | null): void {
  override = next;
}
