import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  PanResponder,
  ActivityIndicator,
  TextInput,
  useWindowDimensions,
  Alert,
  type LayoutChangeEvent,
  type GestureResponderEvent,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { RTCView, type MediaStream } from 'react-native-webrtc';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from '@sayem314/react-native-keep-awake';
import Clipboard from '@react-native-clipboard/clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Modifier, CaptureMode } from '@lilypad/protocol';
import type { RootStackParamList } from '../types';
import { theme } from '../theme';
import { ViewerConnection, type ViewerState, type RecoveryDetail } from '../lib/webrtc';
import type { InputSender } from '../lib/input';
import { appError, toAppError, type AppError } from '../lib/errors';
import { QUALITY_COLOR, type ConnectionQuality } from '../lib/quality';
import { TouchInterpreter, type TouchIntent, type TouchSample } from '../lib/touch';
import {
  IDENTITY_VIEWPORT,
  clampViewport,
  isZoomed,
  panBy,
  toRNTransform,
  zoomAt,
  type Viewport,
} from '../lib/viewport';
import { PressRepeater } from '../lib/pressRepeat';
import { agentFeedReducer, INITIAL_AGENT_FEED } from '../lib/agentFeed';
import { forgetPair, loadPairs, setPairSecret } from '../lib/pairs';
import { requestConnect } from '../lib/api';
import { AgentPanel } from './AgentPanel';

type Props = NativeStackScreenProps<RootStackParamList, 'Viewer'>;

/** Sticky modifier toggles (Cmd/Shift/Alt/Ctrl) that apply to the NEXT click
 * or drag, then auto-clear — giving Cmd-click, Shift-click, Option-drag a
 * discoverable affordance without a physical keyboard. See
 * `docs/audit/m3/input-touch.md` Finding 5. */
const STICKY_MODS: { label: string; mod: Modifier }[] = [
  { label: '⌘', mod: 'meta' },
  { label: '⇧', mod: 'shift' },
  { label: '⌥', mod: 'alt' },
  { label: '⌃', mod: 'ctrl' },
];

type ShortcutAction = Parameters<InputSender['shortcut']>[0];
/** `repeatable` is opt-in per entry, not blanket-applied: held-repeat is a
 * meaningful, expected interaction for arrows/Tab, but repeated Copy/Paste/
 * Undo/Redo on a long-press would be actively harmful. See
 * `docs/audit/m3/input-touch.md` Finding 14. */
const TOOLBAR: { label: string; action: ShortcutAction; repeatable?: boolean }[] = [
  { label: 'Copy', action: 'copy' },
  { label: 'Paste', action: 'paste' },
  { label: 'Esc', action: 'escape' },
  { label: 'Tab', action: 'tab', repeatable: true },
  { label: 'Enter', action: 'enter' },
  { label: '←', action: 'arrow_left', repeatable: true },
  { label: '↑', action: 'arrow_up', repeatable: true },
  { label: '↓', action: 'arrow_down', repeatable: true },
  { label: '→', action: 'arrow_right', repeatable: true },
];

const STATE_LABEL: Record<ViewerState, string> = {
  connecting: 'Connecting…',
  awaiting_approval: 'Waiting for approval…',
  negotiating: 'Negotiating…',
  connected: 'Connected',
  reconnecting_signaling: 'Reconnecting…',
  recovering_ice: 'Recovering connection…',
  denied: 'Request denied',
  failed: 'Connection failed',
  ended: 'Disconnected',
};

/** How long to sit in `awaiting_approval` before nudging with a "Still
 * there?" line — see docs/audit/m3/mobile-ux.md Finding 1. */
const STILL_THERE_MS = 20_000;

/** How long the "Copied from Mac" toast stays up after a clipboard-update
 * arrives. See docs/audit/m3/prior-art.md Finding 6. */
const CLIPBOARD_TOAST_MS = 2_000;

/** How long a first Disconnect tap stays "armed" waiting for the confirming
 * second tap before reverting to normal. See
 * docs/audit/m3/mobile-ux.md Finding 13. */
const CONFIRM_DISCONNECT_MS = 2_000;

/** How long the "Switching to X Mode…" toast stays up after requesting a
 * capture-mode switch — the desktop's rebuild is a brief, sub-second glitch,
 * so this only needs to bridge that gap. See
 * `docs/audit/m3/prior-art.md` Finding 2. */
const MODE_TOAST_MS = 2_000;

const MODE_LABEL: Record<CaptureMode, string> = {
  motion: 'Motion',
  text: 'Text',
};

export function ViewerScreen({ route, navigation }: Props) {
  const { roomId, signalingUrl, scopes, desktopDeviceName, desktopDeviceId } = route.params;
  // A live remote-control session is exactly the "video player" case iOS's
  // idle timer exempts: the user is watching/controlling without touching
  // the screen. Without this, Auto-Lock (30s under Low Power Mode) suspends
  // the app mid-session and tears down the WebRTC connection.
  useKeepAwake();
  // A fixed 16px container padding was either too generous or insufficient
  // depending on device notch/Dynamic-Island/home-indicator geometry — this
  // was pure accident-of-dev-device luck, not a deliberate choice. See
  // docs/audit/m3/mobile-ux.md Finding 15.
  const insets = useSafeAreaInsets();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<ViewerState>('connecting');
  const [recovery, setRecovery] = useState<RecoveryDetail | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [quality, setQuality] = useState<ConnectionQuality | null>(null);
  const [hudExpanded, setHudExpanded] = useState(false);
  const [stillThere, setStillThere] = useState(false);
  // Bumped by "Reconnect" — a dependency of the connection-lifecycle effect
  // below, so bumping it tears down the old (terminal) ViewerConnection and
  // stands up a fresh one against the same room/scopes without a new QR
  // scan. See docs/audit/m3/mobile-ux.md Finding 5.
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [stickyMods, setStickyMods] = useState<Modifier[]>([]);
  const [clipboardToast, setClipboardToast] = useState(false);
  const [captureMode, setCaptureModeState] = useState<CaptureMode>('motion');
  const [modeToast, setModeToast] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const connRef = useRef<ViewerConnection | null>(null);
  const layout = useRef({ w: 1, h: 1 });
  // Pinch-zoom viewport over the remote screen. The transform is pushed to
  // the native view in ONE `setNativeProps` call per gesture event — no
  // re-render per frame (state-driven transforms re-rendered the whole
  // screen at touch-event rate), and no per-component Animated.setValue
  // sequencing (three separate value flushes let a frame render with the
  // new scale but the old translation, which read as stretching/breaking
  // mid-pinch). React state holds only the COARSE zoom summary (badge text,
  // hints), updated when the rounded scale changes, not per frame.
  const viewportRef = useRef<Viewport>(IDENTITY_VIEWPORT);
  const videoWrapRef = useRef<View>(null);
  const [zoomBadge, setZoomBadge] = useState<string | null>(null);
  const [zoomLock, setZoomLock] = useState(false);
  // Landscape: the phone is rotated → give the remote screen the whole
  // display and collapse the controls into a toggleable tray.
  const win = useWindowDimensions();
  const isLandscape = win.width > win.height;
  const [trayOpen, setTrayOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [agentFeed, dispatchAgent] = useReducer(agentFeedReducer, INITIAL_AGENT_FEED);
  // Source video pixel size, from the desktop's `frame-size` signal. `null`
  // until it arrives (full-bleed fallback) — see Finding 1.
  const videoSize = useRef<{ x: number; y: number } | null>(null);
  const interp = useRef(new TouchInterpreter());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmDisconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the memoized PanResponder closures, which would otherwise
  // capture a stale `stickyMods`.
  const stickyModsRef = useRef<Modifier[]>([]);
  stickyModsRef.current = stickyMods;
  const hiddenInputRef = useRef<TextInput>(null);
  const composedTextRef = useRef('');
  // One PressRepeater per repeatable toolbar action, created lazily on
  // first press. See docs/audit/m3/input-touch.md Finding 14.
  const toolbarRepeatersRef = useRef(new Map<ShortcutAction, PressRepeater>());

  const syncGeometry = useCallback(() => {
    interp.current.setGeometry({ x: layout.current.w, y: layout.current.h }, videoSize.current);
  }, []);

  const updateViewport = useCallback((next: Viewport) => {
    viewportRef.current = next;
    interp.current.setViewport(next);
    videoWrapRef.current?.setNativeProps({
      style: {
        transform: toRNTransform(next, { w: layout.current.w, h: layout.current.h }),
      },
    });
    // Re-render only when the visible zoom summary changes.
    setZoomBadge((prev) => {
      const next2 = isZoomed(next) ? `${next.scale.toFixed(1)}×` : null;
      return next2 === prev ? prev : next2;
    });
  }, []);

  useEffect(() => {
    setStream(null);
    setError(null);
    setRecovery(null);
    setQuality(null);
    setStillThere(false);
    videoSize.current = null;
    syncGeometry();
    const conn = new ViewerConnection(signalingUrl, roomId, scopes, {
      onStream: setStream,
      onState: (next, detail) => {
        setState(next);
        setRecovery(next === 'recovering_ice' ? (detail ?? null) : null);
      },
      onError: setError,
      onStats: setQuality,
      onFrameSize: (w, h, mode) => {
        videoSize.current = { x: w, y: h };
        syncGeometry();
        setCaptureModeState(mode);
      },
      onClipboardUpdate: (text) => {
        Clipboard.setString(text);
        if (clipboardToastTimer.current) clearTimeout(clipboardToastTimer.current);
        setClipboardToast(true);
        clipboardToastTimer.current = setTimeout(
          () => setClipboardToast(false),
          CLIPBOARD_TOAST_MS,
        );
      },
      onAgentStep: (step) => dispatchAgent({ type: 'step', step }),
      onAgentRunEnd: (end) => dispatchAgent({ type: 'run_end', end }),
      onPairSecret: (secret) => {
        // Persist the connect secret against this desktop pair (M5.4), so
        // future no-QR reconnects present it. Only possible when we know which
        // desktop this is (always true for QR pairs via the redeem response).
        if (desktopDeviceId) void setPairSecret(desktopDeviceId, secret).catch(() => {});
      },
      onRevoked: () => {
        // The desktop revoked this phone's trust — the stale local pairing
        // can never reconnect (the backend pair row is gone), so drop it
        // now rather than leave a phantom entry in My Devices that just
        // fails the next time it's tapped. Reuses the same removal
        // mechanism as the user-initiated "Forget" in DeviceListScreen,
        // just triggered by the backend instead of a tap.
        if (desktopDeviceId) void forgetPair(desktopDeviceId).catch(() => {});
        // Same explanation as the other revoke path (a rejected no-QR
        // reconnect attempt, `classifyHttpStatus`'s 'trust_revoked') — the
        // user should see identical copy either way.
        Alert.alert('Access revoked', appError('trust_revoked').message, [
          { text: 'OK', onPress: () => navigation.popToTop() },
        ]);
      },
    });
    connRef.current = conn;
    conn.start().catch((e) => setError(toAppError(e)));
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (clipboardToastTimer.current) clearTimeout(clipboardToastTimer.current);
      if (modeToastTimer.current) clearTimeout(modeToastTimer.current);
      if (confirmDisconnectTimer.current) clearTimeout(confirmDisconnectTimer.current);
      for (const repeater of toolbarRepeatersRef.current.values()) repeater.stop();
      conn.close();
    };
  }, [signalingUrl, roomId, scopes, reconnectAttempt, syncGeometry, desktopDeviceId]);

  // Lazily create (once per action) and start/stop the toolbar's held-repeat
  // timer. See docs/audit/m3/input-touch.md Finding 14.
  const onToolbarPressIn = useCallback((action: ShortcutAction) => {
    let repeater = toolbarRepeatersRef.current.get(action);
    if (!repeater) {
      repeater = new PressRepeater(() => connRef.current?.inputSender?.shortcut(action));
      toolbarRepeatersRef.current.set(action, repeater);
    }
    repeater.start();
  }, []);

  const onToolbarPressOut = useCallback((action: ShortcutAction) => {
    toolbarRepeatersRef.current.get(action)?.stop();
  }, []);

  // Ask the desktop to switch capture/encode mode. Optimistically flips the
  // toggle's own highlighted state (rather than waiting for the desktop's
  // `frame-size` echo) so the button feels responsive; `onFrameSize` above
  // is still the source of truth and will correct this if the switch fails
  // silently (best-effort send) or the desktop was already mid-switch.
  const requestCaptureMode = useCallback(
    (mode: CaptureMode) => {
      if (mode === captureMode) return;
      connRef.current?.requestCaptureMode(mode);
      setCaptureModeState(mode);
      if (modeToastTimer.current) clearTimeout(modeToastTimer.current);
      setModeToast(true);
      modeToastTimer.current = setTimeout(() => setModeToast(false), MODE_TOAST_MS);
    },
    [captureMode],
  );

  // "Still there?" nudge — only meaningful while genuinely waiting on a
  // human at the laptop, not during any other state.
  useEffect(() => {
    if (state !== 'awaiting_approval') {
      setStillThere(false);
      return;
    }
    const t = setTimeout(() => setStillThere(true), STILL_THERE_MS);
    return () => clearTimeout(t);
  }, [state]);

  const onLayout = (e: LayoutChangeEvent) => {
    layout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
    syncGeometry();
    // A size change (rotation, keyboard) can leave the pan outside its new
    // legal range — re-clamp so the content never detaches from the edges.
    updateViewport(clampViewport(viewportRef.current, layoutSize()));
  };

  const layoutSize = () => ({ w: layout.current.w, h: layout.current.h });

  const canControl = scopes.includes('control');

  // Turn the interpreter's high-level intents into InputSender calls (remote)
  // or viewport updates (view-local pinch/pan/zoom). Sticky modifiers ride
  // the next press/click, then auto-clear.
  const applyIntents = useCallback(
    (intents: TouchIntent[]) => {
      const inp = connRef.current?.inputSender;
      for (const it of intents) {
        switch (it.kind) {
          // View-local: steer the zoom viewport, nothing sent to the desktop.
          case 'pinch':
            updateViewport(
              zoomAt(viewportRef.current, { x: it.cx, y: it.cy }, it.ratio, layoutSize()),
            );
            break;
          case 'pan':
            updateViewport(panBy(viewportRef.current, it.dx, it.dy, layoutSize()));
            break;
          case 'zoom_reset':
            updateViewport(IDENTITY_VIEWPORT);
            break;
          case 'pointer_down':
            inp?.pointerDown(it.x, it.y, 'left', consumeSticky(stickyModsRef, setStickyMods));
            break;
          case 'pointer_move':
            inp?.pointerMove(it.x, it.y);
            break;
          case 'pointer_up':
            inp?.pointerUp(it.x, it.y);
            break;
          case 'click':
            inp?.click(
              it.x,
              it.y,
              it.button,
              it.count,
              consumeSticky(stickyModsRef, setStickyMods),
            );
            break;
          case 'scroll':
            inp?.scroll(it.x, it.y, it.dx, it.dy);
            break;
        }
      }
    },
    [updateViewport],
  );

  // A single timer tracks the interpreter's pending long-press deadline; it
  // fires the right-click without the component polling.
  const armDeadline = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    const at = interp.current.nextDeadline();
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      applyIntents(interp.current.deadline(Date.now()));
    }, delay);
  }, [applyIntents]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => canControl,
        onMoveShouldSetPanResponder: () => canControl,
        // Multi-touch aware: `touches` carries every active finger, so the
        // interpreter can tell a one-finger drag from a two-finger scroll.
        onPanResponderGrant: (e) => {
          applyIntents(interp.current.begin(samplesFrom(e), Date.now()));
          armDeadline();
        },
        onPanResponderMove: (e) => {
          applyIntents(interp.current.move(samplesFrom(e), Date.now()));
          armDeadline();
        },
        onPanResponderRelease: (e) => {
          applyIntents(interp.current.end(samplesFrom(e), Date.now()));
          armDeadline();
        },
        onPanResponderTerminate: (e) => {
          applyIntents(interp.current.end(samplesFrom(e), Date.now()));
          armDeadline();
        },
      }),
    [canControl, applyIntents, armDeadline],
  );

  const disconnect = useCallback(() => {
    connRef.current?.close();
    // Return to the EXISTING "Your laptops" screen at the stack root, not a
    // fresh copy. `replace('Devices')` swapped the Viewer for a *second*
    // Devices screen ([Devices, Devices]), so its header back button popped to
    // an identical page. Devices is always the root (initialRouteName), so
    // popToTop returns to the single instance with no back button.
    navigation.popToTop();
  }, [navigation]);

  // Two-tap confirm: the Disconnect button sits in the thumb-reach zone
  // directly below a scrollable toolbar the user is actively tapping through
  // — a single accidental tap must not irreversibly end the session. The
  // first tap only arms a 2s confirm window (button relabels/recolors);
  // a second tap within that window actually disconnects. See
  // docs/audit/m3/mobile-ux.md Finding 13.
  const onDisconnectPress = useCallback(() => {
    if (confirmingDisconnect) {
      if (confirmDisconnectTimer.current) clearTimeout(confirmDisconnectTimer.current);
      setConfirmingDisconnect(false);
      disconnect();
      return;
    }
    setConfirmingDisconnect(true);
    confirmDisconnectTimer.current = setTimeout(() => {
      setConfirmingDisconnect(false);
    }, CONFIRM_DISCONNECT_MS);
  }, [confirmingDisconnect, disconnect]);

  /**
   * Get back into a session with this laptop.
   *
   * Bumping `reconnectAttempt` alone re-runs the effect against the SAME
   * `roomId`, and a room does not outlive the laptop leaving it: once the
   * desktop is reaped, its authorization record goes with it and every
   * re-register earns `unauthorized_room`. Retrying that is retrying
   * something that cannot succeed — observed on production as three attempts
   * in four seconds, then nothing.
   *
   * So: ring the laptop again first, exactly as the laptop list does, and
   * carry the phone into the NEW room. Falling back to the in-place retry is
   * still right for the cases a fresh ring cannot serve — a QR session for a
   * laptop this phone never saved, where there is no secret to ring with, and
   * where the honest instruction is to scan again.
   */
  const reconnect = useCallback(() => {
    void (async () => {
      if (!desktopDeviceId) {
        setReconnectAttempt((n) => n + 1);
        return;
      }
      const pair = (await loadPairs()).find((p) => p.desktopDeviceId === desktopDeviceId);
      if (!pair?.connectSecret) {
        setReconnectAttempt((n) => n + 1);
        return;
      }
      try {
        const res = await requestConnect(pair.apiBaseUrl, pair.desktopDeviceId, pair.connectSecret);
        // `replace`, not `navigate`: the old room is gone, and leaving a
        // screen pointed at it in the stack means Back returns to a session
        // that can only fail.
        navigation.replace('Viewer', {
          roomId: res.roomId,
          signalingUrl: res.signalingUrl,
          scopes: res.scopes,
          desktopDeviceName: res.desktopDeviceName ?? pair.name,
          desktopDeviceId: pair.desktopDeviceId,
        });
      } catch (e) {
        setError(toAppError(e));
      }
    })();
  }, [desktopDeviceId, navigation]);

  // Types into the remote session via a hidden, off-screen TextInput — this
  // preserves the OS keyboard's autocorrect/IME/predictive-text instead of
  // building a custom on-screen QWERTY layout. Only the newly-typed
  // increment is sent each keystroke; Backspace is forwarded as a key event
  // since it deletes rather than appends. See
  // docs/audit/m3/mobile-ux.md Finding 3.
  const toggleKeyboard = useCallback(() => {
    if (keyboardOpen) {
      hiddenInputRef.current?.blur();
      Keyboard.dismiss();
    } else {
      hiddenInputRef.current?.focus();
    }
  }, [keyboardOpen]);

  // The iPhone software keyboard has no dismiss key of its own and it covers
  // the bottom control row (including the ⌨ toggle) — without an affordance
  // ABOVE the keyboard there is literally no way out of typing. The
  // accessory bar (below) is that affordance; this listener keeps our state
  // honest if the OS dismisses the keyboard by other means.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => sub.remove();
  }, []);

  const onComposedChangeText = useCallback((next: string) => {
    const inp = connRef.current?.inputSender;
    const prev = composedTextRef.current;
    if (inp && next.length > prev.length && next.startsWith(prev)) {
      inp.text(next.slice(prev.length));
    }
    composedTextRef.current = next;
  }, []);

  const onComposedKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (e.nativeEvent.key === 'Backspace') {
      connRef.current?.inputSender?.keyDown('Backspace');
    }
  }, []);

  const zoomLockRef = useRef(false);
  const toggleZoomLock = useCallback(() => {
    const next = !zoomLockRef.current;
    zoomLockRef.current = next;
    interp.current.setZoomLock(next);
    setZoomLock(next);
  }, []);

  // The fourth lock: "Ask". While the panel is open, typed text is a command
  // to the AI agent (dispatched over the input channel), not keystrokes to the
  // Mac. See docs/m5.3-ai-executor-plan.md §6.
  const sendAgentCommand = useCallback((text: string) => {
    const runId = connRef.current?.sendAgentCommand(text);
    if (runId) dispatchAgent({ type: 'command_sent', runId });
  }, []);
  const stopAgent = useCallback(() => {
    if (agentFeed.runId) {
      connRef.current?.sendAgentStop(agentFeed.runId);
      // Optimistic local stop: the desktop's own run-end (if it arrives) is a
      // harmless duplicate, but if the desktop-side run already died — or the
      // link is broken — waiting for it leaves Stop looking dead and the
      // panel on "Thinking…" forever. Stop must always visibly stop.
      dispatchAgent({
        type: 'run_end',
        end: { kind: 'agent_run_end', runId: agentFeed.runId, outcome: 'stopped', ts: Date.now() },
      });
    }
  }, [agentFeed.runId]);
  const decideAgent = useCallback(
    (stepId: string, approve: boolean) => {
      if (agentFeed.runId) connRef.current?.sendAgentDecision(agentFeed.runId, stepId, approve);
    },
    [agentFeed.runId],
  );

  // Landscape is a full-bleed video surface: the navigation header would
  // burn a permanent strip of the exact screen space rotating is meant to
  // reclaim. (Feature-checked: the test harness's navigation stub has no
  // setOptions.)
  useEffect(() => {
    if (typeof navigation.setOptions === 'function') {
      navigation.setOptions({ headerShown: !isLandscape });
    }
  }, [navigation, isLandscape]);

  const controlsBlock = (
    <>
      {canControl ? (
        <View style={styles.modeRow}>
          {(['motion', 'text'] as const).map((m) => {
            const active = captureMode === m;
            return (
              <Pressable
                key={m}
                testID={`mode-toggle-${m}`}
                style={[styles.modeKey, active && styles.modeKeyActive]}
                onPress={() => requestCaptureMode(m)}
              >
                <Text style={[styles.keyText, active && styles.stickyKeyTextActive]}>
                  {MODE_LABEL[m]}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            testID="mode-toggle-zoom"
            style={[styles.modeKey, zoomLock && styles.modeKeyActive]}
            onPress={toggleZoomLock}
          >
            <Text style={[styles.keyText, zoomLock && styles.stickyKeyTextActive]}>Zoom</Text>
          </Pressable>
          <Pressable
            testID="mode-toggle-ask"
            style={[styles.modeKey, askOpen && styles.modeKeyActive]}
            onPress={() =>
              setAskOpen((v) => {
                // Closing the panel must also release its keyboard — the
                // panel unmounts and an orphaned keyboard has no dismisser.
                if (v) Keyboard.dismiss();
                return !v;
              })
            }
          >
            <Text style={[styles.keyText, askOpen && styles.stickyKeyTextActive]}>Ask</Text>
          </Pressable>
          <Text style={styles.stickyHint}>
            {zoomLock
              ? 'Zoom lock: drag pans, pinch zooms — taps stay local'
              : 'Text mode trades frame rate for sharper detail'}
          </Text>
        </View>
      ) : null}

      {canControl ? (
        <View style={styles.stickyRow}>
          {STICKY_MODS.map((m) => {
            const active = stickyMods.includes(m.mod);
            return (
              <Pressable
                key={m.mod}
                style={[styles.stickyKey, active && styles.stickyKeyActive]}
                onPress={() =>
                  setStickyMods((prev) =>
                    prev.includes(m.mod) ? prev.filter((x) => x !== m.mod) : [...prev, m.mod],
                  )
                }
              >
                <Text style={[styles.keyText, active && styles.stickyKeyTextActive]}>
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
          <Text style={styles.stickyHint}>
            {zoomLock
              ? 'two-finger double-tap resets zoom'
              : zoomBadge
                ? 'two-finger drag scrolls · Zoom lock to pan'
                : 'pinch zooms · two-finger drag scrolls · long-press right-clicks'}
          </Text>
        </View>
      ) : null}

      {/* Visible so a user on a narrow phone has a cue that more keys exist
       * off-screen — nine equal-width buttons with the indicator hidden gave
       * no signal at all. See docs/audit/m3/mobile-ux.md Finding 14. */}
      {canControl ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.toolbar}>
          {TOOLBAR.map((k) =>
            k.repeatable ? (
              <Pressable
                key={k.label}
                style={styles.key}
                onPressIn={() => onToolbarPressIn(k.action)}
                onPressOut={() => onToolbarPressOut(k.action)}
              >
                <Text style={styles.keyText}>{k.label}</Text>
              </Pressable>
            ) : (
              <Pressable
                key={k.label}
                style={styles.key}
                onPress={() => connRef.current?.inputSender?.shortcut(k.action)}
              >
                <Text style={styles.keyText}>{k.label}</Text>
              </Pressable>
            ),
          )}
        </ScrollView>
      ) : null}

      {canControl && askOpen ? (
        <AgentPanel
          feed={agentFeed}
          onSend={sendAgentCommand}
          onStop={stopAgent}
          onDecide={decideAgent}
        />
      ) : null}

      <View style={styles.controls}>
        {canControl ? (
          <Pressable
            style={[styles.keyboardToggle, keyboardOpen && styles.keyboardToggleActive]}
            onPress={toggleKeyboard}
          >
            <Text style={styles.keyboardToggleText}>⌨</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.disconnect, confirmingDisconnect && styles.disconnectConfirming]}
          onPress={onDisconnectPress}
          testID="disconnect-button"
        >
          <Text style={styles.disconnectText}>
            {confirmingDisconnect ? 'Tap again to disconnect' : 'Disconnect'}
          </Text>
        </Pressable>
      </View>
    </>
  );

  return (
    <View
      testID="viewer-container"
      style={[
        styles.container,
        isLandscape
          ? styles.containerLandscape
          : {
              paddingTop: Math.max(16, insets.top),
              paddingBottom: Math.max(16, insets.bottom),
              paddingLeft: Math.max(16, insets.left),
              paddingRight: Math.max(16, insets.right),
            },
      ]}
    >
      <View
        style={[styles.screen, isLandscape && styles.screenLandscape]}
        onLayout={onLayout}
        {...panResponder.panHandlers}
      >
        {stream ? (
          <View
            ref={videoWrapRef}
            style={[
              StyleSheet.absoluteFill,
              { transform: toRNTransform(viewportRef.current, layoutSize()) },
            ]}
            pointerEvents="none"
          >
            <RTCView
              streamURL={stream.toURL()}
              style={StyleSheet.absoluteFill}
              objectFit="contain"
            />
          </View>
        ) : (
          <ViewerPlaceholder
            state={state}
            recovery={recovery}
            error={error}
            stillThere={stillThere}
            desktopDeviceName={desktopDeviceName}
            onCancel={disconnect}
            onReconnect={reconnect}
            onBack={disconnect}
          />
        )}
        <Pressable
          testID="quality-badge"
          style={styles.badge}
          onPress={() => setHudExpanded((v) => !v)}
          disabled={!quality}
        >
          <View style={styles.badgeRow}>
            {quality ? (
              <View
                style={[styles.qualityDot, { backgroundColor: QUALITY_COLOR[quality.level] }]}
              />
            ) : null}
            <Text style={styles.badgeText}>
              {STATE_LABEL[state]}
              {zoomBadge ? ` · ${zoomBadge}` : ''}
            </Text>
          </View>
          {hudExpanded && quality ? (
            <View style={styles.hud}>
              <Text style={styles.hudText}>{quality.rttMs ?? '—'} ms</Text>
              <Text style={styles.hudText}>{quality.bitrateKbps ?? '—'} kbps</Text>
              <Text style={styles.hudText}>{quality.fps ?? '—'} fps</Text>
            </View>
          ) : null}
        </Pressable>
        {clipboardToast ? (
          <View style={styles.toast} testID="clipboard-toast">
            <Text style={styles.toastText}>Copied from Mac</Text>
          </View>
        ) : null}
        {modeToast ? (
          <View style={styles.toast} testID="mode-toast">
            <Text style={styles.toastText}>Switching to {MODE_LABEL[captureMode]} Mode…</Text>
          </View>
        ) : null}
      </View>

      {isLandscape ? (
        <>
          {trayOpen ? (
            <View
              style={[
                styles.trayOverlay,
                {
                  paddingBottom: Math.max(10, insets.bottom),
                  paddingLeft: Math.max(12, insets.left),
                  paddingRight: Math.max(12, insets.right),
                },
              ]}
              testID="landscape-tray"
            >
              {controlsBlock}
            </View>
          ) : null}
          <Pressable
            style={[styles.trayHandle, { right: Math.max(14, insets.right) }]}
            onPress={() => setTrayOpen((v) => !v)}
            testID="tray-handle"
          >
            <Text style={styles.trayHandleText}>{trayOpen ? '⌄' : '⌃'}</Text>
          </Pressable>
        </>
      ) : (
        controlsBlock
      )}

      {canControl ? (
        <TextInput
          ref={hiddenInputRef}
          style={styles.hiddenInput}
          onFocus={() => setKeyboardOpen(true)}
          onBlur={() => {
            setKeyboardOpen(false);
            composedTextRef.current = '';
          }}
          onChangeText={onComposedChangeText}
          onKeyPress={onComposedKeyPress}
          autoCorrect={false}
          autoCapitalize="none"
          inputAccessoryViewID="lilypad-kb-done"
          testID="hidden-keyboard-input"
        />
      ) : null}

      {canControl && Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID="lilypad-kb-done">
          <View style={styles.kbAccessory}>
            <Text style={styles.kbAccessoryLabel}>keys go to your Mac</Text>
            <Pressable
              style={styles.kbAccessoryDone}
              onPress={() => {
                hiddenInputRef.current?.blur();
                Keyboard.dismiss();
              }}
              testID="keyboard-done"
            >
              <Text style={styles.kbAccessoryDoneText}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </View>
  );
}

function ViewerPlaceholder({
  state,
  recovery,
  error,
  stillThere,
  desktopDeviceName,
  onCancel,
  onReconnect,
  onBack,
}: {
  state: ViewerState;
  recovery: RecoveryDetail | null;
  error: AppError | null;
  stillThere: boolean;
  desktopDeviceName: string | null;
  onCancel: () => void;
  onReconnect: () => void;
  onBack: () => void;
}) {
  if (state === 'awaiting_approval') {
    return (
      <View style={styles.placeholder}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.approvalTitle}>Look at your laptop</Text>
        <Text style={styles.meta}>
          Tap Approve on {desktopDeviceName ?? 'the laptop'} to allow this device.
        </Text>
        {stillThere ? (
          <Text style={styles.meta}>Still there? Make sure the laptop is awake and unlocked.</Text>
        ) : null}
        <Pressable style={styles.cancelLink} onPress={onCancel}>
          <Text style={styles.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (state === 'denied') {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.meta}>{desktopDeviceName ?? 'The laptop'} denied this request.</Text>
        <Pressable style={styles.primary} onPress={onBack}>
          <Text style={styles.primaryText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (state === 'failed' || state === 'ended') {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.meta}>{STATE_LABEL[state]}</Text>
        {error ? <Text style={styles.error}>{error.message}</Text> : null}
        <Pressable style={styles.primary} onPress={onReconnect}>
          <Text style={styles.primaryText}>Reconnect</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.placeholder}>
      <ActivityIndicator color={theme.accent} />
      <Text style={styles.meta}>{STATE_LABEL[state]}</Text>
      {state === 'recovering_ice' && recovery ? (
        <Text style={styles.meta}>
          Attempt {recovery.attempt}/{recovery.max}
        </Text>
      ) : null}
      <Text style={styles.meta}>{desktopDeviceName ?? 'Paired laptop'}</Text>
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
    </View>
  );
}

/** Extract every active touch in view-local points from a responder event.
 * `nativeEvent.touches` carries all current touches (empty once the last
 * finger lifts), which is exactly what the interpreter needs to distinguish
 * one- vs two-finger gestures. */
function samplesFrom(e: GestureResponderEvent): TouchSample[] {
  const touches = e.nativeEvent.touches ?? [];
  return touches.map((t) => ({ x: t.locationX, y: t.locationY }));
}

/** Read and clear the sticky modifiers, returning them for the press/click
 * they apply to. Auto-clear is the whole point — a sticky Shift affects only
 * the next gesture, then releases. */
function consumeSticky(
  ref: React.MutableRefObject<Modifier[]>,
  setSticky: React.Dispatch<React.SetStateAction<Modifier[]>>,
): Modifier[] {
  const mods = ref.current;
  if (mods.length > 0) {
    ref.current = [];
    setSticky([]);
  }
  return mods;
}

const styles = StyleSheet.create({
  // Padding itself is applied inline per-edge from useSafeAreaInsets(),
  // Math.max'd against this 16px minimum — see Finding 15.
  container: { flex: 1, backgroundColor: theme.bg, gap: 12 },
  /** Landscape: the video IS the screen — zero chrome, zero padding. */
  containerLandscape: { padding: 0, gap: 0 },
  screen: {
    flex: 1,
    backgroundColor: '#000',
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 16,
    overflow: 'hidden',
  },
  screenLandscape: { borderWidth: 0, borderRadius: 0 },
  trayHandle: {
    position: 'absolute',
    bottom: 14,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderColor: theme.line,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 40,
  },
  trayHandleText: { color: theme.ink, fontSize: 18, lineHeight: 20 },
  kbAccessory: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.bg,
    borderTopColor: theme.line,
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  kbAccessoryLabel: { color: theme.muted, fontSize: 12 },
  kbAccessoryDone: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  kbAccessoryDoneText: { color: theme.onAccent, fontWeight: '700', fontSize: 14 },
  trayOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(7,14,11,0.94)',
    borderTopColor: theme.line,
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 10,
    zIndex: 30,
  },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  approvalTitle: { color: theme.ink, fontSize: 18, fontWeight: '700' },
  meta: { color: theme.muted, fontSize: 13, textAlign: 'center', paddingHorizontal: 20 },
  error: { color: theme.danger, fontSize: 13, paddingHorizontal: 20, textAlign: 'center' },
  cancelLink: { marginTop: 8 },
  cancelLinkText: { color: theme.accent, fontWeight: '600' },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryText: { color: theme.onAccent, fontWeight: '700', fontSize: 15 },
  badge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qualityDot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { color: theme.ink, fontSize: 12 },
  hud: { marginTop: 4, gap: 2 },
  hudText: { color: theme.muted, fontSize: 11 },
  toast: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  toastText: { color: theme.ink, fontSize: 13, fontWeight: '600' },
  toolbar: { maxHeight: 52 },
  key: {
    backgroundColor: theme.panel,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginRight: 8,
    // Single-glyph arrow buttons otherwise land in the 42-48pt range,
    // straddling Apple's 44pt HIG minimum without reliably clearing it — a
    // borderline tap target is exactly the wrong place to mis-tap on a
    // remote-control surface. See docs/audit/m3/mobile-ux.md Finding 20.
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: { color: theme.ink, fontWeight: '600' },
  stickyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stickyKey: {
    backgroundColor: theme.panel,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  stickyKeyActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  stickyKeyTextActive: { color: theme.onAccent },
  stickyHint: { color: theme.muted, fontSize: 11, flex: 1 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  modeKey: {
    backgroundColor: theme.panel,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  modeKeyActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 1,
    width: '100%',
    bottom: 0,
    left: 0,
  },
  controls: { flexDirection: 'row', gap: 10 },
  keyboardToggle: {
    backgroundColor: theme.panel,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardToggleActive: { borderColor: theme.accent },
  keyboardToggleText: { color: theme.ink, fontSize: 18 },
  disconnect: {
    flex: 1,
    backgroundColor: theme.danger,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  // Visually distinct "armed" state so the two-tap requirement is
  // discoverable rather than a hidden trap. See
  // docs/audit/m3/mobile-ux.md Finding 13.
  disconnectConfirming: {
    backgroundColor: '#7a0d0d',
    borderWidth: 2,
    borderColor: theme.danger,
  },
  disconnectText: { color: theme.onDanger, fontWeight: '700', fontSize: 16 },
});
