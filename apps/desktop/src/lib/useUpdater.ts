import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { updater, type Update } from './tauri';

/**
 * The updater's lifecycle as one explicit state machine, so the UI never has
 * to infer "what's happening" from a tangle of booleans:
 *
 *   idle → checking → { uptodate | available }
 *   available → downloading → ready → restarting → (process exit)
 *   any → error
 */
export type UpdatePhase =
  'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'restarting' | 'error';

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
   * The steps used to collapse into a bare `error` phase, so a download that
   * died halfway was reported as "Update check failed" — the wrong step named,
   * and no way to retry the one that actually broke. Inferring it from
   * `newVersion` would be wrong too: a check that fails after an earlier one
   * succeeded still has a version sitting in state.
   */
  failedStep: 'check' | 'download' | 'relaunch' | null;
}

/**
 * How often an `auto` updater re-asks after its launch check.
 *
 * A launch-only check is not a check for an app that installs a login item and
 * then runs for weeks. Measured on 2026-09-08: this Mac last launched Lilypad
 * at 01:08 UTC on 2026-09-07, v0.1.31 published at 04:09 the same morning, and
 * the app was still serving sessions a day later on 0.1.30 — there was simply
 * never another launch for a launch-time check to happen at.
 *
 * Six hours means a release reaches a machine that never restarts within a day,
 * at the cost of four requests for a small JSON manifest. `RUNBOOK.md` §4
 * documents this cadence.
 */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A successful restart request should tear this webview down almost
 * immediately. If it is still alive after this bound, the request stalled and
 * the user needs an honest fallback instead of a button that appeared inert. */
export const RELAUNCH_WATCHDOG_MS = 3_000;

/**
 * One line in the desktop log for each thing the updater learns (L-333).
 *
 * A webview's console never reaches `~/Library/Logs/Lilypad`, so without this
 * the only record of a check was React state — and twice a Mac sat on an old
 * version for a day with nothing in its log to say whether it had even asked.
 *
 * It must never affect the update itself: a failed write, or no Tauri runtime
 * at all (which makes `invoke` throw synchronously), is swallowed.
 */
function record(event: string): void {
  try {
    void invoke('log_update_event', { event }).catch(() => {});
  } catch {
    /* No Tauri runtime. The update flow must not care. */
  }
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
  const relaunchWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (relaunchWatchdog.current) clearTimeout(relaunchWatchdog.current);
      relaunchWatchdog.current = null;
    };
  }, []);

  const check = useCallback(async () => {
    // A manual Check remains visible in Diagnostics while an update is
    // pending. Re-checking at that point can return `null` because the plugin
    // already installed the bundle, collapse `ready` to `uptodate`, and hide
    // the only Restart button. The pending update owns the state machine until
    // relaunch or a download error is resolved.
    if (pending.current) return pending.current;
    setState((s) => ({ ...s, phase: 'checking', error: null, failedStep: null }));
    try {
      const update = await updater.check();
      record(
        update
          ? `update ${update.version} available (running ${update.currentVersion})`
          : 'update check: up to date',
      );
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
      record(`update check failed: ${errorText(e)}`);
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
      record(`update ${update.version} downloaded and installed, waiting for relaunch`);
      if (!alive.current) return;
      setState((s) => ({ ...s, phase: 'ready', progress: 1 }));
    } catch (e) {
      // A stale installer under a fresh manifest fails its signature here
      // (L-332), which is exactly the failure nobody could see.
      record(`update ${update.version} download failed: ${errorText(e)}`);
      if (!alive.current) return;
      // `pending.current` is deliberately left in place: the update is still
      // the right one to install, so retrying is one call rather than another
      // round trip to the feed.
      setState((s) => ({ ...s, phase: 'error', error: errorText(e), failedStep: 'download' }));
    }
  }, []);

  const relaunch = useCallback(async () => {
    const version = pending.current?.version ?? 'unknown';
    if (relaunchWatchdog.current) clearTimeout(relaunchWatchdog.current);
    record(`update ${version} restart requested`);
    setState((s) => ({ ...s, phase: 'restarting', error: null, failedStep: null }));

    // Schedule before awaiting. Tauri's request normally kills this webview,
    // so the promise may never settle; if neither rejection nor process exit
    // happens, this is the only observer that can make the inert button honest.
    relaunchWatchdog.current = setTimeout(() => {
      relaunchWatchdog.current = null;
      if (!alive.current) return;
      const message = `Lilypad is still running. Quit and reopen it to finish installing version ${version}.`;
      record(`update ${version} restart stalled: process still running`);
      setState((s) => ({ ...s, phase: 'error', error: message, failedStep: 'relaunch' }));
    }, RELAUNCH_WATCHDOG_MS);

    try {
      await updater.relaunch();
    } catch (e) {
      if (relaunchWatchdog.current) clearTimeout(relaunchWatchdog.current);
      relaunchWatchdog.current = null;
      record(`update ${version} restart failed: ${errorText(e)}`);
      if (!alive.current) return;
      setState((s) => ({ ...s, phase: 'error', error: errorText(e), failedStep: 'relaunch' }));
    }
  }, []);

  /** Retry whichever step failed. A failed download retries the download —
   * re-checking would throw away a perfectly good update and make the user
   * wait for the feed again. */
  const retry = useCallback(async () => {
    if (state.failedStep === 'relaunch') await relaunch();
    else if (pending.current) await downloadAndInstall();
    else await check();
  }, [check, downloadAndInstall, relaunch, state.failedStep]);

  useEffect(() => {
    if (!auto) return;
    void check();
    const timer = setInterval(() => {
      // Never re-check once something is pending. A repeat check replaces
      // `pending` and drops the phase back to `available`, which would throw
      // away a download that had already finished and leave the user staring
      // at a button they already pressed.
      if (pending.current) return;
      void check();
    }, AUTO_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [auto, check]);

  return { state, check, downloadAndInstall, relaunch, retry };
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Update failed';
}
