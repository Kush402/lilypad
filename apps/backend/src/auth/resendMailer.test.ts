import { describe, it, expect, vi, afterEach } from 'vitest';
import { createResendMailSender } from './resendMailer.js';

/** Captures what would go over the wire, so the assertions are about the
 * REQUEST rather than about a mocked client's ergonomics. */
function stubFetch(response: Partial<Response> & { ok: boolean; status: number }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve('provider said no'),
    } as Response);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('createResendMailSender', () => {
  // Half-configured is the dangerous state: it looks live and fails on every
  // send. Refusing to build a sender turns that into an honest 503 instead.
  it.each([
    ['no key', undefined, 'Lilypad <no-reply@example.com>'],
    ['no from address', 'key_123', undefined],
    ['neither', undefined, undefined],
  ])('returns null with %s', (_label, key, from) => {
    expect(createResendMailSender(key, from)).toBeNull();
  });

  it('builds a sender when both halves are present', () => {
    expect(createResendMailSender('key_123', 'Lilypad <no-reply@example.com>')).not.toBeNull();
  });

  it('posts the sign-in code to Resend, addressed to the user', async () => {
    const calls = stubFetch({ ok: true, status: 200 });
    const sender = createResendMailSender('key_123', 'Lilypad <no-reply@example.com>')!;
    await sender.sendMagicLink('user@example.com', 'CODE-1234');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer key_123');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.to).toBe('user@example.com');
    expect(body.from).toBe('Lilypad <no-reply@example.com>');
    expect(body.text).toContain('CODE-1234');
  });

  it('sends a reset code with reset wording, not sign-in wording', async () => {
    const calls = stubFetch({ ok: true, status: 200 });
    const sender = createResendMailSender('key_123', 'Lilypad <no-reply@example.com>')!;
    await sender.sendPasswordReset('user@example.com', 'RESET-9');

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.subject).toMatch(/reset/i);
    expect(body.text).toContain('RESET-9');
    // The two mails must not be confusable: a reset mail telling someone to
    // "finish signing in" is how a user ignores a real account takeover.
    expect(body.text).not.toMatch(/finish signing in/i);
  });

  // A provider failure must reach the caller. The routes decide what the user
  // sees; swallowing it here would turn a dead end into a silent one.
  it('throws when Resend rejects the message', async () => {
    stubFetch({ ok: false, status: 422 });
    const sender = createResendMailSender('key_123', 'Lilypad <no-reply@example.com>')!;
    await expect(sender.sendMagicLink('user@example.com', 'CODE')).rejects.toThrow(/422/);
  });

  // The failure body can name the address and the provider's reason; it belongs
  // in logs, never in something the route might echo back.
  it('does not put the recipient address in the thrown message', async () => {
    stubFetch({ ok: false, status: 403 });
    const sender = createResendMailSender('key_123', 'Lilypad <no-reply@example.com>')!;
    await expect(sender.sendMagicLink('secret@example.com', 'CODE')).rejects.not.toThrow(
      /secret@example\.com/,
    );
  });
});
