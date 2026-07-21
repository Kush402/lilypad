import { InputSender, MAX_BUFFERED_AMOUNT_BYTES } from './input';

describe('InputSender', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function decode(sent: string[]) {
    return sent.map((raw) => JSON.parse(raw) as { kind: string; events: Array<{ kind: string }> });
  }

  it('coalesces consecutive pointer moves into a single batch on the next tick', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    sender.pointerMove(0.1, 0.2);
    sender.pointerMove(0.15, 0.25);
    sender.pointerMove(0.2, 0.3);
    // Not flushed yet — moves are coalesced until POINTER_COALESCE_MS elapses.
    expect(sent).toHaveLength(0);

    jest.advanceTimersByTime(8);

    expect(sent).toHaveLength(1);
    const [batch] = decode(sent);
    expect(batch.kind).toBe('input_batch');
    expect(batch.events).toHaveLength(3);
    expect(batch.events.every((e) => e.kind === 'pointer_move')).toBe(true);
  });

  it('flushes clicks, keys, and shortcuts immediately without waiting for the coalesce timer', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    sender.click(0.5, 0.5);
    expect(sent).toHaveLength(1);

    sender.keyDown('KeyA');
    expect(sent).toHaveLength(2);

    sender.shortcut('copy');
    expect(sent).toHaveLength(3);

    // No pending timer work outstanding — nothing left to flush.
    jest.advanceTimersByTime(100);
    expect(sent).toHaveLength(3);
  });

  it('flushes a pending pointer-move batch immediately when an immediate event interrupts it', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    sender.pointerMove(0.1, 0.1);
    sender.pointerDown(0.1, 0.1);

    // The pending move and the pointer_down both went out as separate sends
    // — one per channel/queue (docs/audit/m3/input-touch.md Finding 2) —
    // rather than one combined batch, since with the move channel wired in
    // production these are two different DataChannels.
    expect(sent).toHaveLength(2);
    const [moveBatch, criticalBatch] = decode(sent);
    expect(moveBatch.events.map((e) => e.kind)).toEqual(['pointer_move']);
    expect(criticalBatch.events.map((e) => e.kind)).toEqual(['pointer_down']);

    // The coalesce timer that was scheduled for the move must not fire a
    // second, empty flush later.
    jest.advanceTimersByTime(50);
    expect(sent).toHaveLength(2);
  });

  it('does not emit an empty batch when flush is called with nothing queued', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    sender.flush();

    expect(sent).toHaveLength(0);
  });

  it('applies default button/modifiers/count when callers omit them', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    // Each call is an immediate-flush event, so these arrive as two separate
    // single-event batches, not one combined batch.
    sender.pointerDown(0.3, 0.4);
    sender.keyDown('Enter');

    const [downBatch, keyBatch] = decode(sent);
    const [down] = downBatch.events as Array<Record<string, unknown>>;
    const [key] = keyBatch.events as Array<Record<string, unknown>>;
    expect(down.button).toBe('left');
    expect(down.modifiers).toEqual([]);
    expect(key.modifiers).toEqual([]);
    expect(key.repeat).toBe(false);
  });

  it('stamps a monotonically increasing seq on every event (Finding 8 ordering)', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    sender.click(0.1, 0.1);
    sender.click(0.2, 0.2);
    sender.pointerDown(0.3, 0.3);

    const batches = decode(sent) as unknown as Array<{ events: Array<{ seq: number }> }>;
    const seqs = batches.flatMap((b) => b.events.map((e) => e.seq));
    expect(seqs).toEqual([1, 2, 3]);
    // Strictly increasing, so the desktop's dedup/order gate never wedges on a
    // wall-clock step.
    for (let n = 1; n < seqs.length; n++) expect(seqs[n]).toBeGreaterThan(seqs[n - 1]!);
  });

  it('carries pointer modifiers on down/click (Finding 5 Cmd-click / Shift-click)', () => {
    const sent: string[] = [];
    const sender = new InputSender((data) => sent.push(data));

    sender.pointerDown(0.3, 0.4, 'left', ['meta']);
    sender.click(0.5, 0.5, 'right', 1, ['shift', 'alt']);

    const [downBatch, clickBatch] = decode(sent) as unknown as Array<{
      events: Array<Record<string, unknown>>;
    }>;
    expect(downBatch.events[0]!.modifiers).toEqual(['meta']);
    expect(clickBatch.events[0]!.button).toBe('right');
    expect(clickBatch.events[0]!.modifiers).toEqual(['shift', 'alt']);
  });

  // ── two-channel routing (docs/audit/m3/input-touch.md Finding 2) ─────────

  describe('move-channel routing', () => {
    it('routes pointer_move and scroll onto the move channel once wired, everything else onto the critical one', () => {
      const critical: string[] = [];
      const move: string[] = [];
      const sender = new InputSender((data) => critical.push(data));
      sender.setMoveChannel((data) => move.push(data));

      sender.pointerMove(0.1, 0.1);
      sender.scroll(0.2, 0.2, 1, 2);
      sender.click(0.3, 0.3);

      const moveBatches = decode(move);
      const criticalBatches = decode(critical);
      expect(moveBatches.flatMap((b) => b.events.map((e) => e.kind))).toEqual([
        'pointer_move',
        'scroll',
      ]);
      expect(criticalBatches.flatMap((b) => b.events.map((e) => e.kind))).toEqual(['click']);
    });

    it('falls back to the critical channel for moves/scroll when no move channel is wired', () => {
      const sent: string[] = [];
      const sender = new InputSender((data) => sent.push(data));
      // setMoveChannel() never called — matches the peer never negotiating
      // (or not yet opening) the unreliable channel.

      sender.pointerMove(0.1, 0.1);
      jest.advanceTimersByTime(20);

      expect(sent).toHaveLength(1);
      const [batch] = decode(sent);
      expect(batch.events.map((e) => e.kind)).toEqual(['pointer_move']);
    });

    it('reverts to the fallback if the move channel is cleared (e.g. it closed)', () => {
      const critical: string[] = [];
      const move: string[] = [];
      const sender = new InputSender((data) => critical.push(data));
      sender.setMoveChannel((data) => move.push(data));

      sender.pointerMove(0.1, 0.1);
      jest.advanceTimersByTime(20);
      expect(move).toHaveLength(1);

      sender.setMoveChannel(null);
      sender.pointerMove(0.2, 0.2);
      jest.advanceTimersByTime(20);

      expect(move).toHaveLength(1); // unchanged
      expect(critical).toHaveLength(1); // the second move landed here instead
    });

    it('coalesces scroll deltas like pointer moves, not flushing each one immediately (Finding 11)', () => {
      const move: string[] = [];
      const sender = new InputSender(() => {});
      sender.setMoveChannel((data) => move.push(data));

      sender.scroll(0.5, 0.5, 1, 1);
      sender.scroll(0.5, 0.5, 2, 2);
      expect(move).toHaveLength(0); // not flushed yet — still coalescing

      jest.advanceTimersByTime(20);
      expect(move).toHaveLength(1);
      const [batch] = decode(move);
      expect(batch.events).toHaveLength(2);
    });

    it('drops disposable moves when the move channel is backed up instead of spilling them onto critical', () => {
      const critical: string[] = [];
      const move: string[] = [];
      const moveRef = { bufferedAmount: MAX_BUFFERED_AMOUNT_BYTES + 1 };
      const criticalRef = { bufferedAmount: 0 };
      const sender = new InputSender((data) => critical.push(data));
      sender.setCriticalChannelRef(criticalRef);
      sender.setMoveChannel((data) => move.push(data), moveRef);

      sender.pointerMove(0.1, 0.1);
      jest.advanceTimersByTime(20);

      expect(move).toHaveLength(0);
      expect(critical).toHaveLength(0);

      moveRef.bufferedAmount = 0;
      sender.pointerMove(0.2, 0.2);
      jest.advanceTimersByTime(20);

      expect(move).toHaveLength(1);
      expect(decode(move)[0].events).toHaveLength(1);
    });

    it('queues critical input while the reliable channel is backed up and flushes it later', () => {
      const critical: string[] = [];
      const criticalRef = { bufferedAmount: MAX_BUFFERED_AMOUNT_BYTES + 1 };
      const sender = new InputSender((data) => critical.push(data));
      sender.setCriticalChannelRef(criticalRef);

      sender.click(0.4, 0.4);
      expect(critical).toHaveLength(0);

      criticalRef.bufferedAmount = 0;
      sender.flush();

      expect(critical).toHaveLength(1);
      expect(decode(critical)[0].events.map((e) => e.kind)).toEqual(['click']);
    });
  });
});
