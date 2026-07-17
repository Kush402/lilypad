import { PressRepeater, PRESS_REPEAT_INITIAL_DELAY_MS, PRESS_REPEAT_INTERVAL_MS } from './pressRepeat';

describe('PressRepeater', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires once immediately on start', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    r.start();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('does not repeat before the initial delay elapses', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    r.start();
    jest.advanceTimersByTime(PRESS_REPEAT_INITIAL_DELAY_MS - 1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('a normal tap (start then immediate stop) never triggers a second fire', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    r.start();
    r.stop();
    jest.advanceTimersByTime(10_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('repeats at the steady-state interval once held past the initial delay', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    r.start();
    // Right at the initial delay, the repeat interval has just been armed —
    // its first tick lands one PRESS_REPEAT_INTERVAL_MS later.
    jest.advanceTimersByTime(PRESS_REPEAT_INITIAL_DELAY_MS);
    expect(fire).toHaveBeenCalledTimes(1); // the immediate fire only, so far
    jest.advanceTimersByTime(PRESS_REPEAT_INTERVAL_MS * 3);
    expect(fire).toHaveBeenCalledTimes(4); // immediate + 3 repeat ticks
  });

  it('stops repeating once stop() is called', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    r.start();
    jest.advanceTimersByTime(PRESS_REPEAT_INITIAL_DELAY_MS + PRESS_REPEAT_INTERVAL_MS);
    const callsBeforeStop = fire.mock.calls.length;
    r.stop();
    jest.advanceTimersByTime(PRESS_REPEAT_INTERVAL_MS * 5);
    expect(fire).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it('stop() is idempotent and safe to call without a prior start()', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    expect(() => r.stop()).not.toThrow();
    expect(() => r.stop()).not.toThrow();
  });

  it('a second start() resets the timer instead of leaving the old repeat interval running', () => {
    const fire = jest.fn();
    const r = new PressRepeater(fire);
    r.start();
    // Get the old repeat interval actually ticking (not just scheduled).
    jest.advanceTimersByTime(PRESS_REPEAT_INITIAL_DELAY_MS + PRESS_REPEAT_INTERVAL_MS);
    r.start(); // e.g. a fresh press without a matching stop() in between
    const callsAtRestart = fire.mock.calls.length;
    // The new start()'s own repeat doesn't kick in for PRESS_REPEAT_INITIAL_DELAY_MS —
    // if the OLD repeatTimer (70ms cadence) were still alive, it would have
    // ticked again well within this window.
    jest.advanceTimersByTime(PRESS_REPEAT_INTERVAL_MS);
    expect(fire).toHaveBeenCalledTimes(callsAtRestart);
  });
});
