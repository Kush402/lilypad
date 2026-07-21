import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { extractTunnelUrl, tunnelAdvertisedUrls, startQuickTunnel } from './quickTunnel.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
  }
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;

describe('extractTunnelUrl', () => {
  it('finds the URL inside cloudflared box output', () => {
    const chunk = [
      '+--------------------------------------------------------------+',
      '|  Your quick Tunnel has been created! Visit it at:            |',
      '|  https://liquid-otters-heavily-sing.trycloudflare.com        |',
      '+--------------------------------------------------------------+',
    ].join('\n');
    expect(extractTunnelUrl(chunk)).toBe('https://liquid-otters-heavily-sing.trycloudflare.com');
  });

  it('returns null when no URL is present', () => {
    expect(extractTunnelUrl('Starting tunnel…')).toBeNull();
  });

  it('does not match non-trycloudflare hosts', () => {
    expect(extractTunnelUrl('https://evil.example.com')).toBeNull();
  });
});

describe('tunnelAdvertisedUrls', () => {
  it('derives wss signaling from the https origin', () => {
    expect(tunnelAdvertisedUrls('https://a-b.trycloudflare.com')).toEqual({
      apiBaseUrl: 'https://a-b.trycloudflare.com',
      signalingUrl: 'wss://a-b.trycloudflare.com/ws/signal',
    });
  });
});

describe('startQuickTunnel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces the URL once, and onDown + restart on exit', () => {
    const children: FakeChild[] = [];
    const up = vi.fn();
    const down = vi.fn();
    const handle = startQuickTunnel({
      port: 8080,
      callbacks: { onUp: up, onDown: down },
      spawner: () => {
        const c = new FakeChild();
        children.push(c);
        return asChild(c);
      },
      restartBackoffMs: [100],
    });

    expect(children).toHaveLength(1);
    children[0]!.stderr.emit('data', 'https://one.trycloudflare.com ready');
    children[0]!.stderr.emit('data', 'https://one.trycloudflare.com again'); // dupe chunk
    expect(up).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledWith('https://one.trycloudflare.com');

    // Crash → onDown, then a restart after backoff with a NEW url.
    children[0]!.emit('exit', 1);
    expect(down).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(children).toHaveLength(2);
    children[1]!.stdout.emit('data', 'https://two.trycloudflare.com');
    expect(up).toHaveBeenLastCalledWith('https://two.trycloudflare.com');

    handle.stop();
    expect(children[1]!.killed).toBe(true);
  });

  it('gives up cleanly when cloudflared is not installed (ENOENT)', () => {
    const children: FakeChild[] = [];
    const handle = startQuickTunnel({
      port: 8080,
      callbacks: { onUp: vi.fn(), onDown: vi.fn() },
      spawner: () => {
        const c = new FakeChild();
        children.push(c);
        return asChild(c);
      },
      restartBackoffMs: [100],
    });
    const err = Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' });
    children[0]!.emit('error', err);
    children[0]!.emit('exit', -2);
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(1); // no restart loop for a missing binary
    handle.stop();
  });

  it('stop() prevents any further restarts', () => {
    const children: FakeChild[] = [];
    const handle = startQuickTunnel({
      port: 8080,
      callbacks: { onUp: vi.fn(), onDown: vi.fn() },
      spawner: () => {
        const c = new FakeChild();
        children.push(c);
        return asChild(c);
      },
      restartBackoffMs: [100],
    });
    handle.stop();
    children[0]!.emit('exit', 0);
    vi.advanceTimersByTime(1_000);
    expect(children).toHaveLength(1);
  });

  describe('health monitor', () => {
    // Helper: stand up a tunnel with a no-op reaper (so tests never shell
    // out) and a controllable fake health checker.
    const setup = (healthChecker: ReturnType<typeof vi.fn>) => {
      const children: FakeChild[] = [];
      const up = vi.fn();
      const down = vi.fn();
      const handle = startQuickTunnel({
        port: 8080,
        callbacks: { onUp: up, onDown: down },
        spawner: () => {
          const c = new FakeChild();
          children.push(c);
          return asChild(c);
        },
        restartBackoffMs: [100],
        healthIntervalMs: 15_000,
        healthChecker,
        reapOrphans: () => {},
      });
      children[0]!.stderr.emit('data', 'https://one.trycloudflare.com ready');
      return { children, up, down, handle };
    };

    // Must track HEALTH_FAILURES_BEFORE_RESTART in quickTunnel.ts (currently
    // 8, i.e. ~120s at the 15s interval — patient enough to outlast
    // cloudflared's own ~64s network-change reconnect backoff, per the
    // rationale on that const). Not exported (kept module-private on
    // purpose), so this is duplicated here — bump it if that const changes.
    const FAILURES_BEFORE_RESTART = 8;

    it('N-1 failures then a success does not restart and resets the counter', async () => {
      const healthChecker = vi.fn().mockResolvedValue(false);
      const { children } = setup(healthChecker);

      // N-1 consecutive failures (threshold is FAILURES_BEFORE_RESTART) — no kill yet.
      for (let i = 1; i < FAILURES_BEFORE_RESTART; i++) {
        vi.advanceTimersByTime(15_000);
        await vi.waitFor(() => expect(healthChecker).toHaveBeenCalledTimes(i));
      }
      expect(children[0]!.killed).toBe(false);

      // A healthy probe resets consecutiveFailures back to 0.
      healthChecker.mockResolvedValueOnce(true);
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(healthChecker).toHaveBeenCalledTimes(FAILURES_BEFORE_RESTART));
      expect(children[0]!.killed).toBe(false);

      // A couple more failures after the reset still isn't N in a row.
      healthChecker.mockResolvedValue(false);
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() =>
        expect(healthChecker).toHaveBeenCalledTimes(FAILURES_BEFORE_RESTART + 1),
      );
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() =>
        expect(healthChecker).toHaveBeenCalledTimes(FAILURES_BEFORE_RESTART + 2),
      );
      expect(children[0]!.killed).toBe(false);
    });

    it('N consecutive failures triggers exactly one child.kill()', async () => {
      const healthChecker = vi.fn().mockResolvedValue(false);
      const { children } = setup(healthChecker);

      for (let i = 1; i < FAILURES_BEFORE_RESTART; i++) {
        vi.advanceTimersByTime(15_000);
        await vi.waitFor(() => expect(healthChecker).toHaveBeenCalledTimes(i));
        expect(children[0]!.killed).toBe(false);
      }

      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(healthChecker).toHaveBeenCalledTimes(FAILURES_BEFORE_RESTART));
      expect(children[0]!.killed).toBe(true);

      // The interval is stopped the moment we kill, so further ticks (were
      // the fake process to somehow linger) must not call the checker again.
      vi.advanceTimersByTime(60_000);
      expect(healthChecker).toHaveBeenCalledTimes(FAILURES_BEFORE_RESTART);
    });

    it('clears the health interval on stop() and does not probe afterward', async () => {
      const healthChecker = vi.fn().mockResolvedValue(true);
      const { handle } = setup(healthChecker);

      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(healthChecker).toHaveBeenCalledTimes(1));

      handle.stop();
      vi.advanceTimersByTime(60_000);
      expect(healthChecker).toHaveBeenCalledTimes(1);
    });
  });
});
