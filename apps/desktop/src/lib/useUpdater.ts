import { useCallback, useEffect, useRef, useState } from 'react';
import { updater, type Update } from './tauri';

/**
 * The updater's lifecycle as one explicit state machine, so the UI never has
 * to infer "what's happening" from a tangle of booleans:
 *
 *   idle → checking → { uptodate | available }
 *   available → downloading → ready → (relaunch)
 *   any → error
 */
export type UpdatePhase =
  'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdaterState {
  phase: UpdatePhase;
  /** The available update's version (once `available`/`downloading`/`ready`). */
  newVersion: string | null;
  /** Release notes for the available update, if the feed supplied any. */
  notes: string | null;
  /** 0–1 download progress, or null when the server sends no content length. */
  progress: number | null;
  /** Human-readable failure reason when `phase === 'error'`. */
  error: string | null;
  /**
   * Which step failed, when one did.
   *
   * Both steps used to collapse into a bare `error` phase, so a download that
   * died halfway was reported as "Update check failed" — the wrong step named,
   * and no way to retry the one that actually broke. Inferring it from
   * `newVersion` would be wrong too: a check that fails after an earlier one
   * succeeded still has a version sitting in state.
   */
  failedStep: 'check' | 'download' | null;
}

const INITIAL: UpdaterState = {
  phase: 'idle',
  newVersion: null,
  notes: null,
  progress: null,
  error: null,
  failedStep: null,
};

/**
 * Drives the check → download → install → relaunch flow for the desktop
 * updater. `auto` runs one silent check on mount (used by the launch-time
 * banner); the manual affordance calls `check()` directly.
 *
 * All async results are guarded by an `alive` ref so a check/download that
 * resolves after the window closes never writes to unmounted state.
 */
export function useUpdater(options: { auto?: boolean } = {}) {
  const { auto = false } = options;
  const [state, setState] = useState<UpdaterState>(INITIAL);
  const alive = useRef(true);
  const pending = useRef<Update | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'checking', error: null, failedStep: null }));
    try {
      const update = await updater.check();
      if (!alive.current) return null;
      if (update) {
        pending.current = update;
        setState({
          phase: 'available',
          newVersion: update.version,
          notes: update.body ?? null,
          progress: null,
          error: null,
          failedStep: null,
        });
        return update;
      }
      setState({ ...INITIAL, phase: 'uptodate' });
      return null;
    } catch (e) {
      if (!alive.current) return null;
      setState((s) => ({ ...s, phase: 'error', error: errorText(e), failedStep: 'check' }));
      return null;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    let total = 0;
    let received = 0;
    setState((s) => ({
      ...s,
      phase: 'downloading',
      progress: null,
      error: null,
      failedStep: null,
    }));
    try {
      await update.downloadAndInstall((event) => {
        if (!alive.current) return;
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            received = 0;
            setState((s) => ({ ...s, progress: total > 0 ? 0 : null }));
            break;
          case 'Progress':
            received += event.data.chunkLength;
            if (total > 0) {
              setState((s) => ({ ...s, progress: Math.min(1, received / total) }));
            }
            break;
          case 'Finished':
            setState((s) => ({ ...s, progress: 1 }));
            break;
        }
      });
      if (!alive.current) return;
      setState((s) => ({ ...s, phase: 'ready', progress: 1 }));
    } catch (e) {
      if (!alive.current) return;
      // `pending.current` is deliberately left in place: the update is still
      // the right one to install, so retrying is one call rather than another
      // round trip to the feed.
      setState((s) => ({ ...s, phase: 'error', error: errorText(e), failedStep: 'download' }));
    }
  }, []);

  const relaunch = useCallback(() => updater.relaunch(), []);

  /** Retry whichever step failed. A failed download retries the download —
   * re-checking would throw away a perfectly good update and make the user
   * wait for the feed again. */
  const retry = useCallback(async () => {
    if (pending.current) await downloadAndInstall();
    else await check();
  }, [check, downloadAndInstall]);

  useEffect(() => {
    if (auto) void check();
  }, [auto, check]);

  return { state, check, downloadAndInstall, relaunch, retry };
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Update failed';
}
