import { api, type AppStateDto } from './tauri';
import { useLiveResource } from './useLiveResource';
import { useTauriEvent } from './useTauriEvent';

/**
 * The single source of truth for `AppStateDto` in every window, refreshed
 * exactly when something changed instead of on a fixed timer. The Rust session
 * runner emits a fully event-driven `lilypad://session` stream
 * (`commands.rs`'s `spawn_session_runner`) for this exact purpose.
 *
 * Refreshes go through `useLiveResource`, so a burst of `lilypad://session`
 * events (which fires several `get_state` fetches in quick succession) can
 * never show a stale snapshot: only the latest fetch's result is applied,
 * even if an earlier one resolves later. Previously these concurrent fetches
 * could resolve out of order and flicker the UI back to an old state.
 *
 * Still calls `get_state()` (rather than deriving `AppStateDto`'s full shape
 * from the raw `SessionEvent` stream) — `get_state` stays the one
 * authoritative snapshot; the event is only the "something changed, re-fetch"
 * signal, keeping this hook from duplicating the state reduction
 * `apply_session_event` already does on the Rust side.
 */
export function useAppState(): AppStateDto | null {
  const { value, refresh } = useLiveResource(api.getState);
  useTauriEvent('lilypad://session', refresh);
  return value;
}
