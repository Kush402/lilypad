/**
 * Connection-quality classification for the viewer's on-screen HUD. Product-
 * tunable thresholds, not magic numbers — see `docs/audit/m3/mobile-ux.md`
 * Finding 8.
 */
export type QualityLevel = 'good' | 'fair' | 'poor';

export interface ConnectionQuality {
  level: QualityLevel;
  rttMs: number | null;
  bitrateKbps: number | null;
  fps: number | null;
  packetLossPct: number | null;
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

export const QUALITY_COLOR: Record<QualityLevel, string> = {
  good: '#3ecf8e',
  fair: '#f5a623',
  poor: '#ff5c5c',
};
