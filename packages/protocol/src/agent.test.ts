import { describe, it, expect } from 'vitest';
import { AgentInboundSchema, AgentOutboundSchema, AgentApprovalSchema } from './agent.js';

describe('Ask compatibility boundary', () => {
  it('round-trips a side-effect-free probe and versioned response', () => {
    const hello = { kind: 'agent_hello', runId: 'probe-1', ts: 1 };
    const ready = { kind: 'agent_ready', runId: 'probe-1', protocolVersion: 3, ts: 2 };
    expect(AgentInboundSchema.parse(hello)).toEqual(hello);
    expect(AgentOutboundSchema.parse(ready)).toEqual(ready);
    // Neither an older nor an unknown version parses: version 2 could not
    // disclose a destination, and version 1 could not disclose read grants.
    for (const protocolVersion of [1, 2, 4, undefined]) {
      expect(AgentOutboundSchema.safeParse({ ...ready, protocolVersion }).success).toBe(false);
    }
  });

  it('carries the disclosed destination on a ready frame (L-265)', () => {
    const ready = {
      kind: 'agent_ready',
      runId: 'probe-1',
      protocolVersion: 3,
      destination: {
        profileId: 'openai',
        providerName: 'OpenAI',
        origin: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        local: false,
        consentPolicy: 1,
        consentRevision: 'rev-abc',
        source: 'settings',
      },
      ts: 2,
    };
    expect(AgentOutboundSchema.parse(ready)).toEqual(ready);
    // There is deliberately nowhere for a credential to ride along.
    expect(Object.keys(ready.destination)).not.toContain('apiKey');
    // A Mac that discloses nothing still parses; the phone renders that as
    // "not disclosed" rather than reusing an older destination.
    const { destination: _omitted, ...bare } = ready;
    expect(AgentOutboundSchema.safeParse(bare).success).toBe(true);
  });

  it('preserves legacy commands for an explicit desktop refusal, rejecting unknown versions', () => {
    const command = { kind: 'agent_command', runId: 'run-1', text: 'Open Safari', ts: 1 };
    // An unversioned command still parses so the desktop can refuse it with an
    // explanation rather than a deserialization error.
    expect(AgentInboundSchema.parse(command)).toEqual(command);
    expect(
      AgentInboundSchema.parse({ ...command, protocolVersion: 3, consentRevision: 'rev-abc' }),
    ).toEqual({ ...command, protocolVersion: 3, consentRevision: 'rev-abc' });
    // A version-2 phone cannot echo a revision it was never sent, so its
    // commands do not parse as current ones.
    expect(AgentInboundSchema.safeParse({ ...command, protocolVersion: 2 }).success).toBe(false);
    expect(AgentInboundSchema.safeParse({ ...command, protocolVersion: 4 }).success).toBe(false);
  });

  it('rejects disclosure overflow instead of silently truncating authority', () => {
    const approval = { purpose: 'Run script', writablePaths: [], network: false };
    expect(
      AgentApprovalSchema.safeParse({
        ...approval,
        script: { language: 'shell', source: 'x'.repeat(8193) },
      }).success,
    ).toBe(false);
    expect(
      AgentApprovalSchema.safeParse({ ...approval, writablePaths: Array(33).fill('/tmp/a') })
        .success,
    ).toBe(false);
    expect(
      AgentApprovalSchema.safeParse({ ...approval, writablePaths: ['x'.repeat(1025)] }).success,
    ).toBe(false);
  });

  it('carries read grants, and keeps "absent" distinguishable from "none" (L-247)', () => {
    const approval = { purpose: 'Run script', writablePaths: [], network: false };

    // Present and empty: the desktop said the script reads nothing of theirs.
    expect(AgentApprovalSchema.parse({ ...approval, readablePaths: [] }).readablePaths).toEqual([]);
    // Present and populated: exactly what it may read.
    expect(
      AgentApprovalSchema.parse({ ...approval, readablePaths: ['/Users/me/a.txt'] }).readablePaths,
    ).toEqual(['/Users/me/a.txt']);
    // Absent: an older desktop that grants broad reads and cannot say so. It
    // must stay `undefined` rather than defaulting to `[]`, or the phone would
    // render the most permissive case as the most restrictive one.
    expect(AgentApprovalSchema.parse(approval).readablePaths).toBeUndefined();

    // Same disclosure bounds as the write list — an approval may not exceed
    // what can be shown verbatim.
    expect(
      AgentApprovalSchema.safeParse({ ...approval, readablePaths: Array(33).fill('/tmp/a') })
        .success,
    ).toBe(false);
    expect(
      AgentApprovalSchema.safeParse({ ...approval, readablePaths: ['x'.repeat(1025)] }).success,
    ).toBe(false);
  });
});
