/**
 * LAN-first connect path ([NETWORKING.md](../../../../docs/NETWORKING.md) §3).
 *
 * Steps 1–2 (cached address + mDNS) run concurrently within the probe budget
 * before any cloud call. Cloud behavior is unchanged when LAN is unavailable.
 */
import { LAN_PROBE_BUDGET_MS } from '@lilypad/protocol';
import type { PairedDesktop } from './pairs';
import { lanFetch } from './lanTls';
import { discoverLanDesktop } from './lanDiscovery';

export type ConnectTarget = {
  apiBaseUrl: string;
  /** When set, the phone must pin this TLS cert for the LAN API/signaling. */
  lanTlsCertSha256?: string;
};

/** Prefer LAN when reachable; otherwise the cloud address on the pair. */
export async function resolveConnectTarget(pair: PairedDesktop): Promise<ConnectTarget> {
  const cloud = pair.apiBaseUrl.replace(/\/$/, '');
  const pin = pair.lanTlsCertSha256;
  if (!pin) {
    return { apiBaseUrl: cloud };
  }

  const lan = await tryLanPaths(pair, LAN_PROBE_BUDGET_MS, pin);
  if (lan) {
    return { apiBaseUrl: lan, lanTlsCertSha256: pin };
  }
  return { apiBaseUrl: cloud };
}

async function tryLanPaths(
  pair: PairedDesktop,
  budgetMs: number,
  pin: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (url: string | null) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };

    const timer = setTimeout(() => done(null), budgetMs);
    const finish = (url: string | null) => {
      clearTimeout(timer);
      done(url);
    };

    const attempts: Promise<void>[] = [];

    if (pair.lanApiBaseUrl) {
      const cached = pair.lanApiBaseUrl.replace(/\/$/, '');
      attempts.push(
        probeLanControl(cached, budgetMs, pin).then((ok) => {
          if (ok) finish(cached);
        }),
      );
    }

    attempts.push(
      discoverLanDesktop(pair.desktopDeviceId, budgetMs).then(async (hit) => {
        if (!hit) return;
        const ok = await probeLanControl(hit.apiBaseUrl, budgetMs, pin);
        if (ok) finish(hit.apiBaseUrl.replace(/\/$/, ''));
      }),
    );

    void Promise.allSettled(attempts).then(() => finish(null));
  });
}

async function probeLanControl(
  apiBaseUrl: string,
  budgetMs: number,
  tlsPin?: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const fetchFn = tlsPin
      ? (url: string, init?: RequestInit) => lanFetch(url, tlsPin, init)
      : fetch;
    const res = await fetchFn(`${apiBaseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
