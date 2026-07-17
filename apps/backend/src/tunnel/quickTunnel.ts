import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../logging.js';

/**
 * Cloudflare quick tunnel — zero-config internet reach for signaling.
 *
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` and watches its
 * output for the ephemeral `https://<name>.trycloudflare.com` URL. While the
 * tunnel is up, pairing responses advertise the tunnel's https/wss URLs
 * (via `services/advertisedUrls.ts`), so a phone anywhere on the internet
 * can redeem a QR and reach the signaling WebSocket with no deployed
 * backend, no account, and no TLS setup — Cloudflare terminates TLS and
 * forwards to localhost.
 *
 * Scope: the tunnel carries HTTP + WebSocket SIGNALING only. WebRTC media
 * negotiates its own path via ICE (public STUN for most NATs; a deployed
 * TURN relay is still the answer for symmetric-NAT cases).
 *
 * Quick tunnels are ephemeral by design (new URL each run, no uptime SLA) —
 * exactly right for a solo user's own machine, wrong for production, which
 * pins PUBLIC_BASE_URL/SIGNALING_URL instead (see docs/operations.md).
 */

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Pure: pull the first quick-tunnel URL out of a chunk of cloudflared
 * output (it prints the URL inside an ASCII box on stderr). */
export function extractTunnelUrl(chunk: string): string | null {
  const m = TUNNEL_URL_RE.exec(chunk);
  return m ? m[0] : null;
}

/** Derive the pair of advertised URLs from the tunnel's https origin. */
export function tunnelAdvertisedUrls(httpsOrigin: string): {
  apiBaseUrl: string;
  signalingUrl: string;
} {
  return {
    apiBaseUrl: httpsOrigin,
    signalingUrl: `${httpsOrigin.replace(/^https:/, 'wss:')}/ws/signal`,
  };
}

export interface QuickTunnelCallbacks {
  /** The tunnel is up at this https origin. May fire again after a restart
   * (quick tunnels get a NEW url each time). */
  onUp(httpsOrigin: string): void;
  /** The tunnel went down (process exit). Fired before any restart attempt. */
  onDown(): void;
}

export interface QuickTunnelOptions {
  port: number;
  callbacks: QuickTunnelCallbacks;
  /** Injectable for tests. Defaults to node's spawn of `cloudflared`. */
  spawner?: (port: number) => ChildProcess;
  /** Backoff schedule between restarts (ms). */
  restartBackoffMs?: number[];
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export interface QuickTunnelHandle {
  stop(): void;
}

/**
 * Start (and keep alive) the quick tunnel. Restarts on crash with backoff;
 * a missing `cloudflared` binary is a clean, actionable failure (logged
 * once, no restart loop) — the app continues LAN-only.
 */
export function startQuickTunnel(opts: QuickTunnelOptions): QuickTunnelHandle {
  const backoff = opts.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
  const spawner =
    opts.spawner ??
    ((port: number) =>
      spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const launch = () => {
    if (stopped) return;
    child = spawner(opts.port);

    let announced = false;
    const onChunk = (buf: Buffer | string) => {
      if (announced) return;
      const url = extractTunnelUrl(String(buf));
      if (url) {
        announced = true;
        restarts = 0; // a healthy start resets the backoff ladder
        log.signaling.info({ url }, 'quick tunnel up — QR now advertises the tunnel');
        opts.callbacks.onUp(url);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        stopped = true; // no binary — retrying can't help
        log.signaling.warn(
          'TUNNEL=1 but `cloudflared` is not installed — continuing LAN-only. ' +
            'Install it (macOS: `brew install cloudflared`) and restart.',
        );
        return;
      }
      log.signaling.warn({ err }, 'quick tunnel process error');
    });

    child.on('exit', (code) => {
      child = null;
      if (announced) opts.callbacks.onDown();
      if (stopped) return;
      const delay = backoff[Math.min(restarts, backoff.length - 1)]!;
      restarts += 1;
      log.signaling.warn({ code, retryInMs: delay }, 'quick tunnel exited — restarting');
      restartTimer = setTimeout(launch, delay);
    });
  };

  launch();

  return {
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill();
      child = null;
    },
  };
}
