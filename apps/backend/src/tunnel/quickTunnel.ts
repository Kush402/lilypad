import { spawn, execFile, type ChildProcess } from 'node:child_process';
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
  /** Injectable for tests. Probes the tunnel's own https origin end-to-end
   * and resolves true if it's reachable. Defaults to a real `fetch` probe. */
  healthChecker?: (url: string) => Promise<boolean>;
  /** How often to probe the tunnel while it's announced-up (ms). */
  healthIntervalMs?: number;
  /** Best-effort cleanup of an orphaned cloudflared from a prior hard-killed
   * backend (e.g. `kill -9`), run once before the first launch. Injectable
   * so tests can no-op it. Defaults to a scoped `pkill`. */
  reapOrphans?: (port: number) => void;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/** How often to probe the tunnel's own url while it's announced-up. */
const HEALTH_INTERVAL_MS = 15_000;

/** Timeout for a single health probe request. */
const HEALTH_PROBE_TIMEOUT_MS = 10_000;

/** Consecutive probe failures required before we force a restart. At
 * HEALTH_INTERVAL_MS (15s) intervals, 8 consecutive failures ≈ 120s of
 * sustained unreachability before a forced restart. That has to exceed
 * cloudflared's own network-change reconnect window — its backoff alone can
 * be ~64s ("Retrying connection in up to 1m4s") — so that a sleep/lid-close
 * or WiFi change, where cloudflared drops its edge connections and
 * reconnects with the SAME url, gets a chance to self-heal BEFORE the
 * health-check would kill it. A kill forces a brand-new trycloudflare.com
 * url and strands every phone that already paired against the old one. A
 * genuinely dead "zombie" tunnel (registered but its control stream fails
 * forever) still gets caught: it simply never produces a healthy probe, so
 * it trips the threshold after ~2 minutes. That ~2min zombie-detection
 * latency is an acceptable trade for not churning the url on every normal
 * sleep/WiFi transition — the desktop's QR always advertises the live url
 * as a manual fallback in the meantime. */
const HEALTH_FAILURES_BEFORE_RESTART = 8;

/** Real health probe: reaching cloudflared at all (any HTTP response, even
 * a non-2xx from our own backend) proves the edge→cloudflared→localhost
 * path is intact — that's what we're testing, not the app's status codes.
 * Only a thrown fetch error or a timeout (AbortError) means the tunnel
 * itself is broken. */
async function defaultHealthChecker(httpsOrigin: string): Promise<boolean> {
  try {
    await fetch(`${httpsOrigin}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort reap of a cloudflared orphaned by a hard-killed backend
 * (e.g. `kill -9`, which bypasses `stop()` and leaves the child running).
 * Scoped tightly to OUR exact invocation for OUR port so it can never touch
 * an unrelated cloudflared the user has running for something else. `pkill`
 * exits non-zero when nothing matches, which is the expected common case —
 * swallow all errors, this is cleanup, never load-bearing. */
function defaultReapOrphans(port: number): void {
  execFile(
    'pkill',
    ['-f', `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${port}`],
    () => {
      /* best-effort; non-zero (no match) or missing pkill is fine */
    },
  );
}

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
  const healthChecker = opts.healthChecker ?? defaultHealthChecker;
  const healthIntervalMs = opts.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  const reapOrphans = opts.reapOrphans ?? defaultReapOrphans;

  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let consecutiveFailures = 0;

  /** Stop the health probe. Called the moment we force-kill for a bad
   * verdict (so a restart already in flight can't be double-killed by a
   * late tick), on every child exit, and on stop()/ENOENT. A fresh interval
   * is only ever (re)started from onUp, once the NEW tunnel announces —
   * that's what makes "one unhealthy verdict → exactly one kill → one
   * relaunch" hold: the exit handler below is the SOLE relaunch path, this
   * health path only ever calls child.kill() and gets out of the way. */
  const stopHealthCheck = () => {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  };

  const startHealthCheck = (httpsOrigin: string) => {
    stopHealthCheck(); // defensive: never run two intervals concurrently
    consecutiveFailures = 0;
    healthTimer = setInterval(() => {
      void healthChecker(`${httpsOrigin}/health`).then((healthy) => {
        if (healthy) {
          consecutiveFailures = 0;
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
          // Sustained failure while the process never exited — the "up but
          // disconnected" zombie this file exists to catch. Stop probing
          // (a restart is now in flight) and force one via child.kill();
          // the exit handler owns the actual relaunch + backoff + onUp.
          log.signaling.warn(
            { consecutiveFailures },
            'quick tunnel health probe failed repeatedly — forcing restart',
          );
          stopHealthCheck();
          child?.kill();
        }
      });
    }, healthIntervalMs);
  };

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
        startHealthCheck(url);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        stopped = true; // no binary — retrying can't help
        stopHealthCheck();
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
      stopHealthCheck(); // no probing a dead/relaunching tunnel
      if (announced) opts.callbacks.onDown();
      if (stopped) return;
      const delay = backoff[Math.min(restarts, backoff.length - 1)]!;
      restarts += 1;
      log.signaling.warn({ code, retryInMs: delay }, 'quick tunnel exited — restarting');
      restartTimer = setTimeout(launch, delay);
    });
  };

  // Reap a cloudflared orphaned by a prior `kill -9` of the backend (which
  // bypasses stop()), so orphans don't accumulate across hard restarts. Only
  // called here, once, before the FIRST launch — backoff-restarts of our
  // OWN child go through launch() directly and never re-run this.
  reapOrphans(opts.port);
  launch();

  return {
    stop() {
      stopped = true;
      stopHealthCheck();
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill();
      child = null;
    },
  };
}
