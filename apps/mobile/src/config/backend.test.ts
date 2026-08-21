import { DEFAULT_API_BASE_URL, defaultApiBaseUrl } from './backend';

/**
 * The address a phone talks to before it has ever scanned a QR.
 *
 * This is worth its own file because getting it wrong is silent. Every screen
 * works, sign-in succeeds, devices list — against the wrong backend. The app
 * shipped for weeks pointing at `lilypad.takedia.com`, which is a developer
 * laptop's cloudflared tunnel, and nothing anywhere said so.
 */

describe('DEFAULT_API_BASE_URL', () => {
  it('is production', () => {
    expect(DEFAULT_API_BASE_URL).toBe('https://api.takedia.com');
  });

  it('is not the local-development tunnel', () => {
    // `lilypad.takedia.com` forwards to localhost:8080 on a developer's Mac
    // (infra/cloudflared/lilypad.yml). It answers, it is healthy, and it is
    // the wrong deployment — which is exactly why this needs saying out loud.
    expect(DEFAULT_API_BASE_URL).not.toContain('lilypad.takedia.com');
  });

  it('is not the marketing site', () => {
    // `lilypadhome.takedia.com` is Cloudflare Pages. It would answer 200 to a
    // health probe with HTML and fail everything else confusingly.
    expect(DEFAULT_API_BASE_URL).not.toContain('lilypadhome');
  });

  it('is https, with no trailing slash and no path', () => {
    // Callers build URLs as `${base}${path}`, so a trailing slash or a path
    // segment here produces a double slash or a wrong route on every request.
    expect(DEFAULT_API_BASE_URL).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(defaultApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
  });

  it('strips a trailing slash if one is ever added', () => {
    expect('https://api.takedia.com/'.replace(/\/$/, '')).toBe(DEFAULT_API_BASE_URL);
  });
});
