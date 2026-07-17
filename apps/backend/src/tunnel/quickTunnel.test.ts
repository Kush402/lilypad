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
});
