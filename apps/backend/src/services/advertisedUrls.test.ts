import { afterEach, describe, expect, it } from 'vitest';
import { advertisedUrls, setAdvertisedUrls } from './advertisedUrls.js';
import { env } from '../config.js';

afterEach(() => setAdvertisedUrls(null));

describe('advertisedUrls', () => {
  it('defaults to the configured env URLs', () => {
    expect(advertisedUrls()).toEqual({
      apiBaseUrl: env.PUBLIC_BASE_URL,
      signalingUrl: env.SIGNALING_URL,
    });
  });

  it('a tunnel override wins, and clearing restores env', () => {
    setAdvertisedUrls({
      apiBaseUrl: 'https://x.trycloudflare.com',
      signalingUrl: 'wss://x.trycloudflare.com/ws/signal',
    });
    expect(advertisedUrls().apiBaseUrl).toBe('https://x.trycloudflare.com');
    setAdvertisedUrls(null);
    expect(advertisedUrls().apiBaseUrl).toBe(env.PUBLIC_BASE_URL);
  });
});
