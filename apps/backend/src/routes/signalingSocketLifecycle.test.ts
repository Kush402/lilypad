import { once } from 'node:events';
import websocket from '@fastify/websocket';
import { SIGNALING_PATH } from '@lilypad/protocol';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { signalingRoutes } from './signaling.js';

describe('signaling WebSocket lifecycle', () => {
  it('drops queued frames as soon as the server starts closing the socket', async () => {
    const verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const handleMessage = vi.fn();
    const handleClose = vi.fn();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    await app.register(signalingRoutes, {
      hub: {
        resurrectRoomsFromStore: async () => 0,
        reapStale: () => {},
        shutdownAll: () => {},
        metricsSnapshot: () => ({}),
        isRegistered: () => false,
        handleMessage,
        handleClose,
      },
      sessions: { sweepOrphaned: async () => 0 },
      roomAuth: { verify },
      trust: {},
    } as never);
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}${SIGNALING_PATH}`);
    try {
      await Promise.race([
        once(client, 'open'),
        once(client, 'error').then(([err]) => Promise.reject(err)),
      ]);
      const frame = (roomId: string) =>
        JSON.stringify({
          type: 'register',
          roomId,
          from: 'desktop',
          ts: Date.now(),
          payload: { role: 'desktop', deviceId: 'desktop-01' },
        });
      const closed = once(client, 'close');
      client.send(frame('room-denied'));
      client.send(frame('room-queued'));
      await closed;
      await vi.waitFor(() => expect(handleClose).toHaveBeenCalledTimes(1));

      expect(verify).toHaveBeenCalledTimes(1);
      expect(handleMessage).not.toHaveBeenCalled();
    } finally {
      client.terminate();
      await app.close();
    }
  });

  it('does not register a dead socket when authorization finishes after close', async () => {
    let finishAuthorization!: (allowed: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      finishAuthorization = resolve;
    });
    const verify = vi.fn(async () => authorization);

    const handleMessage = vi.fn();
    const handleClose = vi.fn();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    await app.register(signalingRoutes, {
      hub: {
        resurrectRoomsFromStore: async () => 0,
        reapStale: () => {},
        shutdownAll: () => {},
        metricsSnapshot: () => ({}),
        isRegistered: () => false,
        handleMessage,
        handleClose,
      },
      sessions: { sweepOrphaned: async () => 0 },
      roomAuth: {
        verify,
      },
      trust: {},
    } as never);
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}${SIGNALING_PATH}`);
    try {
      await Promise.race([
        once(client, 'open'),
        once(client, 'error').then(([err]) => Promise.reject(err)),
      ]);
      client.send(
        JSON.stringify({
          type: 'register',
          roomId: 'room-1',
          from: 'desktop',
          ts: Date.now(),
          payload: { role: 'desktop', deviceId: 'desktop-01' },
        }),
      );

      // The frame is inside the awaited room-auth gate. Closing now used to let
      // the close handler run first (with no hub context), then register this
      // already-dead transport when Redis eventually answered.
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
      const closed = once(client, 'close');
      client.terminate();
      await closed;
      await vi.waitFor(() => expect(handleClose).toHaveBeenCalledTimes(1));

      finishAuthorization(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handleMessage).not.toHaveBeenCalled();
    } finally {
      finishAuthorization(false);
      client.terminate();
      await app.close();
    }
  });
});
