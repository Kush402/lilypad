import { describe, it, expect } from 'vitest';
import { AgentInboundSchema, AgentOutboundSchema, AgentApprovalSchema } from './agent.js';

describe('Ask compatibility boundary', () => {
  it('round-trips a side-effect-free probe and versioned response', () => {
    const hello = { kind: 'agent_hello', runId: 'probe-1', ts: 1 };
    const ready = { kind: 'agent_ready', runId: 'probe-1', protocolVersion: 1, ts: 2 };
    expect(AgentInboundSchema.parse(hello)).toEqual(hello);
    expect(AgentOutboundSchema.parse(ready)).toEqual(ready);
    expect(AgentOutboundSchema.safeParse({ ...ready, protocolVersion: 2 }).success).toBe(false);
    expect(AgentOutboundSchema.safeParse({ ...ready, protocolVersion: undefined }).success).toBe(
      false,
    );
  });

  it('preserves legacy commands for an explicit desktop refusal, rejecting unknown versions', () => {
    const command = { kind: 'agent_command', runId: 'run-1', text: 'Open Safari', ts: 1 };
    expect(AgentInboundSchema.parse(command)).toEqual(command);
    expect(AgentInboundSchema.parse({ ...command, protocolVersion: 1 })).toEqual({
      ...command,
      protocolVersion: 1,
    });
    expect(AgentInboundSchema.safeParse({ ...command, protocolVersion: 2 }).success).toBe(false);
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
});
