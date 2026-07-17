import { describe, it, expect } from 'vitest';
import { isAuthorizedMetricsRequest } from './metricsAuth.js';

describe('isAuthorizedMetricsRequest', () => {
  it('authorizes every request when no token is configured (dev convenience)', () => {
    expect(isAuthorizedMetricsRequest(undefined, undefined)).toBe(true);
    expect(isAuthorizedMetricsRequest('Bearer wrong', undefined)).toBe(true);
  });

  it('rejects a request with no Authorization header once a token is configured', () => {
    expect(isAuthorizedMetricsRequest(undefined, 'secret-token')).toBe(false);
  });

  it('rejects a request with the wrong token', () => {
    expect(isAuthorizedMetricsRequest('Bearer wrong-token', 'secret-token')).toBe(false);
  });

  it('authorizes a request with the exact configured bearer token', () => {
    expect(isAuthorizedMetricsRequest('Bearer secret-token', 'secret-token')).toBe(true);
  });

  it('rejects a non-Bearer Authorization scheme even if the token matches', () => {
    expect(isAuthorizedMetricsRequest('Basic secret-token', 'secret-token')).toBe(false);
  });
});
