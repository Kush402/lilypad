import { describe, it, expect } from 'vitest';
import { parseAllowedOrigins } from './allowedOrigins.js';

describe('parseAllowedOrigins', () => {
  it('defaults an empty string to false — no cross-origin browser client allowed', () => {
    expect(parseAllowedOrigins('')).toBe(false);
  });

  it('treats a whitespace-only string as empty', () => {
    expect(parseAllowedOrigins('   ')).toBe(false);
  });

  it('parses a single origin into a one-element allowlist', () => {
    expect(parseAllowedOrigins('https://admin.lilypad.example')).toEqual([
      'https://admin.lilypad.example',
    ]);
  });

  it('parses a comma-separated list, trimming whitespace around each entry', () => {
    expect(parseAllowedOrigins('https://a.example, https://b.example ,https://c.example')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('drops empty entries from stray commas', () => {
    expect(parseAllowedOrigins('https://a.example,,https://b.example,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
