import { AppState, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

/**
 * Debounce window before treating a background transition as real, rather
 * than a brief OS-chrome swipe — iOS control-center/notification-center
 * gestures can flash `inactive` for under a second. A quick swipe-down-and-back
 * must not pause the stream.
 */
const BACKGROUND_DEBOUNCE_MS = 2_000;

export interface AppLifecycleCallbacks {
  /** The app has been backgrounded for longer than the debounce window. */
  onBackground: () => void;
  /** The app returned to the foreground after a real (debounced) background. */
  onForeground: () => void;
  /** Network connectivity just transitioned from disconnected to connected —
   * a new path may be available (e.g. WiFi → cellular handoff completed). */
  onNetworkRestored: () => void;
}

/**
 * Observes OS-level app lifecycle and network connectivity so a live session
 * can react to backgrounding/foregrounding and network-path changes instead
 * of silently freezing or waiting for a slow client-side timeout to notice.
 * See `docs/audit/m3/reconnect-lifecycle.md` Finding 4.
 */
export class AppLifecycleController {
  private appState: AppStateStatus = AppState.currentState;
  private backgroundStartedAt: number | null = null;
  private wasConnected: boolean | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly appSub: { remove: () => void };
  private readonly netUnsubscribe: () => void;

  constructor(private readonly cb: AppLifecycleCallbacks) {
    this.appSub = AppState.addEventListener('change', this.handleAppState);
    this.netUnsubscribe = NetInfo.addEventListener(this.handleNetInfo);
  }

  private handleAppState = (next: AppStateStatus): void => {
    const wasActive = this.appState === 'active';
    const wasBackground = this.appState === 'inactive' || this.appState === 'background';
    const nowBackground = next === 'inactive' || next === 'background';
    const nowActive = next === 'active';

    if (wasActive && nowBackground) {
      this.backgroundStartedAt = Date.now();
      this.backgroundTimer = setTimeout(() => {
        this.backgroundTimer = null;
        this.cb.onBackground();
      }, BACKGROUND_DEBOUNCE_MS);
    } else if (wasBackground && nowActive) {
      // iOS can suspend JS before the debounce callback runs. Timer presence
      // does not prove a brief bounce: elapsed wall time still counts.
      const elapsed =
        this.backgroundStartedAt === null
          ? BACKGROUND_DEBOUNCE_MS
          : Date.now() - this.backgroundStartedAt;
      const notified = this.backgroundTimer === null;
      if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
      this.backgroundStartedAt = null;
      if (notified || elapsed >= BACKGROUND_DEBOUNCE_MS) this.cb.onForeground();
    }
    this.appState = next;
  };

  private handleNetInfo = (state: NetInfoState): void => {
    const connected = !!state.isConnected;
    if (this.wasConnected === false && connected) {
      this.cb.onNetworkRestored();
    }
    this.wasConnected = connected;
  };

  dispose(): void {
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    this.appSub.remove();
    this.netUnsubscribe();
  }
}
