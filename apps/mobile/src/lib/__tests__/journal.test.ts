import { record, recordState, startSession, journalText, entryCount } from '../journal';

/**
 * The phone's half of a session story.
 *
 * The Mac got a log file on 2026-08-24 and it paid for itself immediately.
 * The phone had nothing — its quality HUD shows the numbers live and then
 * they are gone — so a "wobbly on cellular" report could be traced through
 * the backend and the Mac and stopped dead at the device that was actually on
 * the moving network.
 *
 * Two properties matter here, and only one of them is about diagnostics.
 */
describe('the session journal', () => {
  beforeEach(() => startSession());

  it('starts each session clean, so one report is one session', () => {
    record('connected');
    expect(entryCount()).toBe(2); // the start line plus the event
    startSession();
    expect(entryCount()).toBe(1);
  });

  it('reads as a sequence, with relative times', () => {
    record('connected');
    const text = journalText();
    expect(text).toMatch(/Lilypad session log/);
    expect(text).toMatch(/s {2}session started/);
    expect(text).toMatch(/s {2}connected/);
  });

  it('keeps the END of a long session, which is the part being diagnosed', () => {
    for (let i = 0; i < 400; i += 1) record(`event ${i}`);
    const text = journalText();
    expect(text).toContain('event 399');
    expect(text).not.toContain('event 0 ');
    // Bounded, so a long session cannot grow without limit in memory.
    expect(entryCount()).toBeLessThanOrEqual(240);
  });

  /**
   * `connected` is reached from five different places in `webrtc.ts`. Logging
   * each one produces a column of identical lines and buries the transitions
   * that explain the session — the same reason quality is sampled on change.
   */
  it('logs a state once, however many code paths reach it', () => {
    recordState('connected');
    recordState('connected');
    recordState('connected');
    expect(entryCount()).toBe(2); // the start line plus one 'connected'
  });

  it('still records a genuine return to a state, which is the wobble', () => {
    recordState('connected');
    recordState('reconnecting signaling');
    recordState('connected');
    const text = journalText();
    expect(text.match(/connected/g)?.length).toBe(2);
    expect(text).toMatch(/reconnecting signaling/);
  });

  it('carries detail that must never reach the screen', () => {
    // The raw text of a failed SDP apply used to be rendered to the customer
    // verbatim. This is where it goes instead.
    record('offer failed', 'InvalidAccessError: Failed to set remote answer');
    expect(journalText()).toContain('InvalidAccessError');
  });

  /**
   * A support paste is something a customer sends to a stranger. An IP address
   * in it is somebody's home; a room id is a live session; an email is an
   * account. The journal records state, codes and numbers — and that rule is
   * worth a test rather than a comment, because the next person adding a
   * `record()` call will not have read the comment.
   */
  it('never carries anything that identifies a person or a place', () => {
    startSession();
    record('connecting');
    record('quality poor', 'rtt 412ms · 180kbps · 12fps · loss 7%');
    record('reconnecting signaling');
    record('offer failed', 'InvalidAccessError: Failed to set remote answer');
    const text = journalText();

    // No IPv4 literal — candidate addresses are the obvious way one arrives.
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    // No email.
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    // No uuid — room, session and device ids are all uuids.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // No SDP: `a=candidate` lines carry addresses and `m=` lines carry ports.
    expect(text).not.toMatch(/^[amc]=/m);
  });
});
