/**
 * Connection-quality classification for the viewer's on-screen HUD. Product-
 * tunable thresholds, not magic numbers — see `docs/audit/m3/mobile-ux.md`
 * Finding 8.
 */
import { theme } from '../theme';

export type QualityLevel = 'good' | 'fair' | 'poor';

/**
 * Three separate questions about the picture (L-273).
 *
 * They used to be one. `bytesReceived` advancing was recorded as
 * "video advanced", that timestamp suppressed recovery and reported the
 * session connected, and there was no decoded-frame check anywhere — so video
 * that arrived and could not be decoded read as a healthy stream while the
 * person watched a frozen image.
 *
 *   - `flowing`   — bytes are arriving. A statement about the network.
 *   - `decoding`  — decoded frames are advancing. A statement about the picture.
 *   - `control`   — the input channel is open. A statement about whether
 *                   anything the person does can reach the Mac.
 *
 * A legitimately static screen is `flowing: false, decoding: false`: an idle
 * encoder sends almost nothing. Undecodable video is `flowing: true,
 * decoding: false`, which is the one that needs recovering.
 */
export interface VideoHealth {
  flowing: boolean;
  /** `null` when the platform reports no decoded-frame statistic: unknown,
   * which is neither yes nor no, and never acted on as a stall. */
  decoding: boolean | null;
  control: boolean;
  /** How many bounded recovery nudges have been spent on a decoder stall. */
  recoveries: number;
}

export interface ConnectionQuality {
  level: QualityLevel;
  rttMs: number | null;
  bitrateKbps: number | null;
  fps: number | null;
  packetLossPct: number | null;
  video: VideoHealth;
}

/** Polling cadence for `RTCPeerConnection.getStats()`, mirroring the existing
 * heartbeat interval's order of magnitude — frequent enough to feel live,
 * infrequent enough not to waste battery on a human-facing indicator. */
export const QUALITY_POLL_MS = 2_000;

const GOOD_RTT_MS = 80;
const GOOD_LOSS_PCT = 2;
const FAIR_RTT_MS = 200;
const FAIR_LOSS_PCT = 5;

export function classifyQuality(rttMs: number | null, packetLossPct: number | null): QualityLevel {
  const rtt = rttMs ?? 0;
  const loss = packetLossPct ?? 0;
  if (rtt <= GOOD_RTT_MS && loss < GOOD_LOSS_PCT) return 'good';
  if (rtt <= FAIR_RTT_MS && loss < FAIR_LOSS_PCT) return 'fair';
  return 'poor';
}

/** The same three semantics the rest of the product uses, not a fourth set of
 * greens and ambers — the desktop's status dots make the identical mapping. */
export const QUALITY_COLOR: Record<QualityLevel, string> = {
  good: theme.accent,
  fair: theme.pending,
  poor: theme.danger,
};
