import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnv, resetEnvCache } from './env.js';

/** A fully secure production configuration — the baseline every "refuses to
 * boot" test mutates one field away from. */
function secureProdEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://api.lilypad.example',
    SIGNALING_URL: 'wss://api.lilypad.example/ws/signal',
    DATABASE_URL: 'postgres://lilypad:s3cr3t@db.internal:5432/lilypad',
    REDIS_URL: 'redis://:s3cr3t@redis.internal:6379',
    TURN_SECRET: 'a-real-unique-secret-at-least-32-chars-long',
    AUTH_TOKEN_SECRET: 'a-real-unique-auth-signing-key-32-chars-plus',
    METRICS_BEARER_TOKEN: 'a-real-unique-metrics-token',
    ...overrides,
  };
}

describe('loadEnv', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv({ NODE_ENV: 'development' });
    expect(env.BACKEND_PORT).toBe(8080);
    expect(env.PAIRING_TOKEN_TTL_SECONDS).toBe(60);
    expect(env.TRUST_PROXY).toBe('');
  });

  it('throws a readable error listing every invalid field', () => {
    expect(() => loadEnv({ BACKEND_PORT: 'not-a-number' })).toThrow(/BACKEND_PORT/);
  });

  it('memoizes the first parse — a second call ignores a different source', () => {
    const first = loadEnv({ NODE_ENV: 'development', BACKEND_PORT: '1111' });
    const second = loadEnv({ NODE_ENV: 'development', BACKEND_PORT: '2222' });
    expect(second).toBe(first);
    expect(second.BACKEND_PORT).toBe(1111);
  });

  it('resetEnvCache lets a fresh source be loaded', () => {
    loadEnv({ NODE_ENV: 'development', BACKEND_PORT: '1111' });
    resetEnvCache();
    const fresh = loadEnv({ NODE_ENV: 'development', BACKEND_PORT: '2222' });
    expect(fresh.BACKEND_PORT).toBe(2222);
  });

  describe('production safety guards', () => {
    it('boots cleanly with a fully secure production configuration', () => {
      expect(() => loadEnv(secureProdEnv())).not.toThrow();
    });

    it('does not apply production guards outside NODE_ENV=production', () => {
      // The same insecure defaults that would fail production must not
      // block dev/test — that's the whole point of them being defaults.
      expect(() => loadEnv({ NODE_ENV: 'development' })).not.toThrow();
    });

    it('refuses the default TURN_SECRET', () => {
      expect(() => loadEnv(secureProdEnv({ TURN_SECRET: 'lilypad_dev_turn_secret' }))).toThrow(
        /TURN_SECRET/,
      );
    });

    it('refuses a TURN_SECRET shorter than 32 characters, even if not the literal dev default', () => {
      expect(() => loadEnv(secureProdEnv({ TURN_SECRET: 'short-but-not-the-default' }))).toThrow(
        /TURN_SECRET/,
      );
    });

    // This key signs every access token, so guessing it mints a token for any
    // account and any device — the whole authorization model reduces to it.
    it('refuses the default AUTH_TOKEN_SECRET', () => {
      expect(() =>
        loadEnv(secureProdEnv({ AUTH_TOKEN_SECRET: 'lilypad_dev_auth_token_secret' })),
      ).toThrow(/AUTH_TOKEN_SECRET/);
    });

    it('refuses an AUTH_TOKEN_SECRET shorter than 32 characters', () => {
      expect(() => loadEnv(secureProdEnv({ AUTH_TOKEN_SECRET: 'too-short' }))).toThrow(
        /AUTH_TOKEN_SECRET/,
      );
    });

    it('refuses to boot without METRICS_BEARER_TOKEN', () => {
      expect(() => loadEnv(secureProdEnv({ METRICS_BEARER_TOKEN: undefined }))).toThrow(
        /METRICS_BEARER_TOKEN/,
      );
    });

    it('refuses the default DATABASE_URL', () => {
      expect(() =>
        loadEnv(
          secureProdEnv({
            DATABASE_URL: 'postgres://lilypad:lilypad_dev_password@localhost:5432/lilypad',
          }),
        ),
      ).toThrow(/insecure configuration/);
    });

    it('refuses a plaintext PUBLIC_BASE_URL', () => {
      expect(() =>
        loadEnv(secureProdEnv({ PUBLIC_BASE_URL: 'http://api.lilypad.example' })),
      ).toThrow(/PUBLIC_BASE_URL/);
    });

    it('refuses a plaintext SIGNALING_URL', () => {
      expect(() =>
        loadEnv(secureProdEnv({ SIGNALING_URL: 'ws://api.lilypad.example/ws/signal' })),
      ).toThrow(/SIGNALING_URL/);
    });

    it('refuses a Redis URL with no password', () => {
      expect(() => loadEnv(secureProdEnv({ REDIS_URL: 'redis://redis.internal:6379' }))).toThrow(
        /REDIS_URL/,
      );
    });

    it('refuses a Redis URL with a username but no password', () => {
      expect(() =>
        loadEnv(secureProdEnv({ REDIS_URL: 'redis://someuser@redis.internal:6379' })),
      ).toThrow(/REDIS_URL/);
    });

    it('treats an unparseable REDIS_URL as unsafe rather than silently passing', () => {
      expect(() => loadEnv(secureProdEnv({ REDIS_URL: 'not a url at all' }))).toThrow(/REDIS_URL/);
    });

    it('reports every problem at once, not just the first', () => {
      try {
        loadEnv(
          secureProdEnv({
            PUBLIC_BASE_URL: 'http://api.lilypad.example',
            SIGNALING_URL: 'ws://api.lilypad.example/ws/signal',
            REDIS_URL: 'redis://redis.internal:6379',
          }),
        );
        expect.unreachable('loadEnv should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toMatch(/PUBLIC_BASE_URL/);
        expect(message).toMatch(/SIGNALING_URL/);
        expect(message).toMatch(/REDIS_URL/);
      }
    });
  });
});
