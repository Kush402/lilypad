import { describe, it, expect } from 'vitest';
import {
  ASK_MAX_CRITERIA,
  ASK_MAX_QUESTIONS,
  HostedAskStatusSchema,
  AskSystemOneReplySchema,
  AskSystemOneRequestSchema,
} from './ask.js';

/**
 * The hosted System One wire contract (ADR-0020).
 *
 * The point of every limit here is that the backend can state a bound on what
 * it carries. A pass-through that accepted any JSON would have no answer to
 * "could a screenshot go through this", and the privacy page would be a
 * promise nothing enforced.
 */
const step = () => ({
  taskId: 'task-aaaaaaaa',
  model: 'jev-1.13.0',
  state: {
    command: 'reply to Rae saying I’ll be there',
    'app in front': 'Mail',
    'controls on the screen': ['e1: row “Rae”', 'e2: button “Reply”'],
  },
  questions: {
    done: { type: 'noul', instructions: 'Has the command been carried out completely?' },
    step: {
      type: 'choice',
      instructions: 'What is the very next step?',
      criteria: { press: 'Click one control', 'Mail.app': null },
    },
  },
});

describe('a hosted Ask step', () => {
  it('accepts the shape the desktop already builds', () => {
    expect(AskSystemOneRequestSchema.safeParse(step()).success).toBe(true);
  });

  it('needs a task id long enough not to collide by accident', () => {
    expect(AskSystemOneRequestSchema.safeParse({ ...step(), taskId: 'abc' }).success).toBe(false);
  });

  it('needs at least one question', () => {
    expect(AskSystemOneRequestSchema.safeParse({ ...step(), questions: {} }).success).toBe(false);
  });

  it('bounds how many questions one step may ask', () => {
    const questions = Object.fromEntries(
      Array.from({ length: ASK_MAX_QUESTIONS + 1 }, (_, i) => [
        `q${i}`,
        { type: 'noul', instructions: 'Is this the next step?' },
      ]),
    );
    expect(AskSystemOneRequestSchema.safeParse({ ...step(), questions }).success).toBe(false);
  });

  it('bounds how many options one question may offer', () => {
    const criteria = Object.fromEntries(
      Array.from({ length: ASK_MAX_CRITERIA + 1 }, (_, i) => [`o${i}`, 'an option']),
    );
    const request = {
      ...step(),
      questions: { step: { type: 'choice', instructions: 'Which?', criteria } },
    };
    expect(AskSystemOneRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts the grounded desktop action shapes but no extra payload fields', () => {
    const actions = {
      'app:Safari': { operation: 'open application', application: 'Safari' },
      website: { operation: 'open website', address: 'https://www.youtube.com/' },
      'press:e2': { operation: 'click', role: 'button', label: 'Reply', where: 'top right' },
      'type:t0': { operation: 'type', 'text from the command': 'hello' },
      wait: 'Wait briefly',
    };
    const question = { type: 'choice', instructions: 'Choose the next action.', criteria: actions };
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        questions: { action: question },
      }).success,
    ).toBe(true);
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        questions: {
          action: {
            ...question,
            criteria: {
              ...actions,
              'press:e3': {
                operation: 'click',
                role: 'button',
                label: 'Reply',
                where: 'top right',
                screenshot: 'data:image/png;base64,AAAA',
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('accepts 120 displayed controls but refuses an unbounded state list', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `e${i}: button “Action ${i}”`);
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        state: { command: 'click Action 119', 'controls on the screen': lines },
      }).success,
    ).toBe(true);
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        state: { command: 'click Action 120', 'controls on the screen': [...lines, 'extra'] },
      }).success,
    ).toBe(false);
  });

  it('refuses a question type nobody implemented', () => {
    const request = {
      ...step(),
      questions: { step: { type: 'essay', instructions: 'Describe the screen' } },
    };
    expect(AskSystemOneRequestSchema.safeParse(request).success).toBe(false);
  });

  it('refuses state that is not text', () => {
    // A number, an object, a boolean — anything that is not a string or a
    // list of them is a field nobody designed and nobody disclosed.
    for (const command of [1, true, { data: 'x' }, [[1]]]) {
      expect(AskSystemOneRequestSchema.safeParse({ ...step(), state: { command } }).success).toBe(
        false,
      );
    }
  });

  it('refuses a state string long enough to be an encoded image', () => {
    const request = { ...step(), state: { command: 'hello', 'app in front': 'x'.repeat(1_001) } };
    expect(AskSystemOneRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts the phone’s maximum command without enlarging other state fields', () => {
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        state: { command: 'x'.repeat(4 * 1024) },
      }).success,
    ).toBe(true);
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        state: { command: 'x'.repeat(4 * 1024 + 1) },
      }).success,
    ).toBe(false);
    expect(
      AskSystemOneRequestSchema.safeParse({
        ...step(),
        state: { command: 'hello', 'app in front': 'x'.repeat(1_001) },
      }).success,
    ).toBe(false);
  });

  it('has nowhere to put a credential', () => {
    expect(() =>
      AskSystemOneRequestSchema.parse({
        ...step(),
        apiKey: 'fixture-not-a-real-key',
      } as never),
    ).toThrow(/Unrecognized key/);
  });
});

describe('a hosted Ask reply', () => {
  it('carries the answers and the counter that was just spent', () => {
    const parsed = AskSystemOneReplySchema.parse({
      model: 'jev-1.13.0',
      answers: { done: { type: 'noul', noul: 0.02 } },
      allowance: { used: 3, limit: 25, resetsAt: '2026-09-20T00:00:00.000Z' },
    });
    expect(parsed.allowance.limit).toBe(25);
  });

  it('refuses an allowance without a reset instant', () => {
    expect(
      AskSystemOneReplySchema.safeParse({
        model: 'jev-1.13.0',
        answers: {},
        allowance: { used: 3, limit: 25, resetsAt: 'tomorrow' },
      }).success,
    ).toBe(false);
  });
});

describe('the hosted Ask preflight', () => {
  it('keeps deployment readiness separate from account entitlement', () => {
    expect(HostedAskStatusSchema.parse({ configured: false })).toEqual({ configured: false });
    expect(HostedAskStatusSchema.parse({ configured: true, access: 'entitled' })).toEqual({
      configured: true,
      access: 'entitled',
    });
  });

  it('refuses invented access states and fields', () => {
    expect(HostedAskStatusSchema.safeParse({ configured: true, access: 'probably' }).success).toBe(
      false,
    );
    expect(HostedAskStatusSchema.safeParse({ configured: false, access: 'entitled' }).success).toBe(
      false,
    );
  });
});
