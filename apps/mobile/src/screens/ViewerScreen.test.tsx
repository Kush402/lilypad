import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import { ViewerScreen } from './ViewerScreen';
import { forgetPair } from '../lib/pairs';

// useSafeAreaInsets() (Finding 15) needs a SafeAreaProvider ancestor;
// initialMetrics makes the value available synchronously on the very first
// render instead of after an async native measurement, which never resolves
// in this jsdom-less test environment.
const TEST_SAFE_AREA_METRICS: Metrics = {
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

jest.mock('../lib/webrtc', () => {
  const instances: any[] = [];
  return {
    __instances: instances,
    ViewerConnection: jest
      .fn()
      .mockImplementation((_url: string, _roomId: string, _scopes: string[], cb: any) => {
        const inputSender = {
          text: jest.fn(),
          keyDown: jest.fn(),
          keyUp: jest.fn(),
          shortcut: jest.fn(),
          pointerDown: jest.fn(),
          pointerMove: jest.fn(),
          pointerUp: jest.fn(),
        };
        const inst = {
          cb,
          inputSender,
          start: jest.fn().mockResolvedValue(undefined),
          close: jest.fn(),
          requestCaptureMode: jest.fn(),
          requestDisplay: jest.fn(),
        };
        instances.push(inst);
        return inst;
      }),
  };
});

jest.mock('react-native-webrtc', () => ({
  RTCView: () => null,
}));

jest.mock('@sayem314/react-native-keep-awake', () => ({
  useKeepAwake: jest.fn(),
}));

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn() },
}));

jest.mock('../lib/pairs', () => ({
  setPairSecret: jest.fn().mockResolvedValue(undefined),
  forgetPair: jest.fn().mockResolvedValue(undefined),
  loadPairs: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/api', () => ({ requestConnectForPair: jest.fn() }));

const { __instances } = jest.requireMock('../lib/webrtc') as { __instances: any[] };
function lastConn() {
  return __instances[__instances.length - 1];
}

function renderViewer(
  scopes: string[] = ['view', 'control'],
  metrics = TEST_SAFE_AREA_METRICS,
  desktopDeviceId?: string,
) {
  const navigation = { replace: jest.fn(), popToTop: jest.fn() } as any;
  const route = {
    key: 'viewer',
    name: 'Viewer' as const,
    params: {
      payload: {
        v: 2,
        token: 'x'.repeat(20),
        roomId: 'r1',
        apiBaseUrl: 'http://x',
        signalingUrl: 'ws://x',
      },
      roomId: 'r1',
      signalingUrl: 'ws://x',
      scopes,
      desktopDeviceName: "Kush's MacBook Pro",
      desktopDeviceId,
    },
  } as any;
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ViewerScreen route={route} navigation={navigation} />
    </SafeAreaProvider>,
  );
  return { navigation };
}

describe('ViewerScreen', () => {
  beforeEach(() => {
    __instances.length = 0;
    (forgetPair as jest.Mock).mockClear();
  });

  it('shows a "look at your laptop" card while awaiting approval, and Cancel disconnects', async () => {
    const { navigation } = renderViewer();
    await act(async () => {
      lastConn().cb.onState('awaiting_approval');
    });

    expect(screen.getByText('Look at your laptop')).toBeTruthy();
    expect(screen.getByText(/Kush's MacBook Pro/)).toBeTruthy();

    fireEvent.press(screen.getByText('Cancel'));
    expect(lastConn().close).toHaveBeenCalled();
    // Returns to the existing root "Your laptops" screen — not a duplicate.
    expect(navigation.popToTop).toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('shows a distinct "denied" card (not the generic failure copy) on pair-denied', async () => {
    renderViewer();
    await act(async () => {
      lastConn().cb.onState('denied');
    });

    expect(screen.getByText(/denied this request/)).toBeTruthy();
    expect(screen.queryByText('Connection failed')).toBeNull();
  });

  it('shows the ICE-recovery attempt count', async () => {
    renderViewer();
    await act(async () => {
      lastConn().cb.onState('recovering_ice', { attempt: 1, max: 2 });
    });

    expect(screen.getByText('Attempt 1/2')).toBeTruthy();
  });

  it('offers a Reconnect button on a terminal failure that starts a fresh ViewerConnection', async () => {
    renderViewer();
    await act(async () => {
      lastConn().cb.onState('failed');
    });

    const firstConn = lastConn();
    fireEvent.press(screen.getByText('Reconnect'));

    expect(__instances.length).toBe(2);
    expect(firstConn.close).toHaveBeenCalled();
    expect(lastConn().start).toHaveBeenCalled();
  });

  it('renders a color-coded quality dot and expands RTT/bitrate/fps on tap', async () => {
    renderViewer();
    await act(async () => {
      lastConn().cb.onStats({
        level: 'good',
        rttMs: 42,
        bitrateKbps: 1200,
        fps: 30,
        packetLossPct: 0,
      });
    });

    fireEvent.press(screen.getByTestId('quality-badge'));
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('1200 kbps')).toBeTruthy();
    expect(screen.getByText('30 fps')).toBeTruthy();
  });

  it('sends only the newly-typed increment via the hidden keyboard input', async () => {
    renderViewer();
    const conn = lastConn();
    const input = screen.getByTestId('hidden-keyboard-input');

    fireEvent.changeText(input, 'h');
    fireEvent.changeText(input, 'hi');

    expect(conn.inputSender.text).toHaveBeenNthCalledWith(1, 'h');
    expect(conn.inputSender.text).toHaveBeenNthCalledWith(2, 'i');
  });

  it('forwards Backspace as a key event instead of trying to diff a shrinking string', async () => {
    renderViewer();
    const conn = lastConn();
    const input = screen.getByTestId('hidden-keyboard-input');

    fireEvent(input, 'keyPress', { nativeEvent: { key: 'Backspace' } });

    expect(conn.inputSender.keyDown).toHaveBeenCalledWith('Backspace');
  });

  it('does not render the keyboard toggle or hidden input for a view-only scope', () => {
    renderViewer(['view']);
    expect(screen.queryByTestId('hidden-keyboard-input')).toBeNull();
  });

  describe('safe-area insets (mobile-ux.md Finding 15)', () => {
    it('falls back to a 16px minimum padding when the device has no real inset', () => {
      renderViewer(['view', 'control'], {
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
        frame: { x: 0, y: 0, width: 390, height: 844 },
      });
      const style = screen.getByTestId('viewer-container').props.style.flat();
      const padding = Object.assign({}, ...style);
      expect(padding.paddingTop).toBe(16);
      expect(padding.paddingBottom).toBe(16);
      expect(padding.paddingLeft).toBe(16);
      expect(padding.paddingRight).toBe(16);
    });

    it('respects a real device inset larger than the 16px minimum (e.g. a notch/home-indicator)', () => {
      renderViewer(['view', 'control'], {
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
        frame: { x: 0, y: 0, width: 390, height: 844 },
      });
      const style = screen.getByTestId('viewer-container').props.style.flat();
      const padding = Object.assign({}, ...style);
      expect(padding.paddingTop).toBe(47);
      expect(padding.paddingBottom).toBe(34);
      // Sides have no real inset on this device — floor still applies.
      expect(padding.paddingLeft).toBe(16);
    });
  });

  describe('disconnect two-tap confirmation (mobile-ux.md Finding 13)', () => {
    it('does not disconnect on a single tap — arms a confirm window instead', () => {
      const { navigation } = renderViewer();
      const conn = lastConn();

      fireEvent.press(screen.getByTestId('disconnect-button'));

      expect(conn.close).not.toHaveBeenCalled();
      expect(navigation.popToTop).not.toHaveBeenCalled();
      expect(screen.getByText('Tap again to disconnect')).toBeTruthy();
    });

    it('disconnects on a second tap within the confirm window', () => {
      const { navigation } = renderViewer();
      const conn = lastConn();
      const button = screen.getByTestId('disconnect-button');

      fireEvent.press(button);
      fireEvent.press(button);

      expect(conn.close).toHaveBeenCalled();
      expect(navigation.popToTop).toHaveBeenCalled();
    });

    it('reverts to the normal label if the confirm window elapses with no second tap', () => {
      jest.useFakeTimers();
      try {
        renderViewer();
        fireEvent.press(screen.getByTestId('disconnect-button'));
        expect(screen.getByText('Tap again to disconnect')).toBeTruthy();

        act(() => {
          jest.advanceTimersByTime(2_100);
        });

        expect(screen.queryByText('Tap again to disconnect')).toBeNull();
        expect(screen.getByText('Disconnect')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('a fresh tap after the window elapsed re-arms rather than immediately disconnecting', () => {
      jest.useFakeTimers();
      try {
        renderViewer();
        const conn = lastConn();
        const button = screen.getByTestId('disconnect-button');

        fireEvent.press(button);
        act(() => {
          jest.advanceTimersByTime(2_100);
        });
        fireEvent.press(button);

        expect(conn.close).not.toHaveBeenCalled();
        expect(screen.getByText('Tap again to disconnect')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('toolbar press-and-hold repeat (Finding 14)', () => {
    it('repeats an arrow-key shortcut while held, and stops on release', () => {
      jest.useFakeTimers();
      try {
        renderViewer();
        const conn = lastConn();
        const button = screen.getByText('→');

        fireEvent(button, 'pressIn');
        expect(conn.inputSender.shortcut).toHaveBeenCalledTimes(1);
        expect(conn.inputSender.shortcut).toHaveBeenLastCalledWith('arrow_right');

        act(() => {
          jest.advanceTimersByTime(400 + 70 * 3);
        });
        expect(conn.inputSender.shortcut.mock.calls.length).toBeGreaterThan(1);

        const callsAtRelease = conn.inputSender.shortcut.mock.calls.length;
        fireEvent(button, 'pressOut');
        act(() => {
          jest.advanceTimersByTime(1000);
        });
        expect(conn.inputSender.shortcut).toHaveBeenCalledTimes(callsAtRelease);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not repeat a non-repeatable toolbar action like Copy', () => {
      jest.useFakeTimers();
      try {
        renderViewer();
        const conn = lastConn();

        fireEvent.press(screen.getByText('Copy'));
        act(() => {
          jest.advanceTimersByTime(2000);
        });
        expect(conn.inputSender.shortcut).toHaveBeenCalledTimes(1);
        expect(conn.inputSender.shortcut).toHaveBeenCalledWith('copy');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('capture mode toggle (Finding 2)', () => {
    it('does not render the mode toggle for a view-only scope', () => {
      renderViewer(['view']);
      expect(screen.queryByTestId('mode-toggle-text')).toBeNull();
    });

    it('requests a mode switch and shows a "Switching to Text Mode…" toast', async () => {
      renderViewer();
      const conn = lastConn();

      fireEvent.press(screen.getByTestId('mode-toggle-text'));

      expect(conn.requestCaptureMode).toHaveBeenCalledWith('text');
      expect(screen.getByTestId('mode-toast')).toBeTruthy();
      expect(screen.getByText('Switching to Text Mode…')).toBeTruthy();
    });

    it('does not re-request the mode it is already in', async () => {
      renderViewer();
      const conn = lastConn();

      // Starts in 'motion' by default — pressing "Motion" again is a no-op.
      fireEvent.press(screen.getByTestId('mode-toggle-motion'));

      expect(conn.requestCaptureMode).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mode-toast')).toBeNull();
    });

    it('reflects the desktop-confirmed mode from a frame-size signal', async () => {
      renderViewer();
      await act(async () => {
        lastConn().cb.onFrameSize(1920, 1080, 'text');
      });

      // Now already in 'text' — pressing "Text" again is a no-op.
      fireEvent.press(screen.getByTestId('mode-toggle-text'));
      expect(lastConn().requestCaptureMode).not.toHaveBeenCalled();
    });
  });

  /**
   * A laptop plugged into a monitor is the ordinary case, and until now
   * Lilypad could only ever show the built-in screen — the second display
   * existed and was unreachable.
   */
  describe('the display switcher', () => {
    const twoDisplays = [
      { id: 1, name: 'Built-in Display', width: 2560, height: 1600 },
      { id: 2, name: 'Display 2', width: 3440, height: 1440 },
    ];

    it('is not there at all on a Mac with one screen', async () => {
      renderViewer();
      await act(async () => {
        lastConn().cb.onDisplays?.(
          [{ id: 1, name: 'Built-in Display', width: 2560, height: 1600 }],
          1,
        );
      });
      expect(screen.queryByTestId('display-1')).toBeNull();
    });

    it('appears once a second display is attached', async () => {
      renderViewer();
      await act(async () => {
        lastConn().cb.onDisplays?.(twoDisplays, 1);
      });
      expect(screen.getByTestId('display-1')).toBeTruthy();
      expect(screen.getByTestId('display-2')).toBeTruthy();
      expect(screen.getByText('Built-in Display')).toBeTruthy();
    });

    it('asks the Mac to switch, and says so while it rebuilds', async () => {
      renderViewer();
      const conn = lastConn();
      await act(async () => {
        conn.cb.onDisplays?.(twoDisplays, 1);
      });

      fireEvent.press(screen.getByTestId('display-2'));

      expect(conn.requestDisplay).toHaveBeenCalledWith(2);
      expect(screen.getByText('Switching to Display 2…')).toBeTruthy();
    });

    it('does not re-request the display already on screen', async () => {
      renderViewer();
      const conn = lastConn();
      await act(async () => {
        conn.cb.onDisplays?.(twoDisplays, 1);
      });

      fireEvent.press(screen.getByTestId('display-1'));

      expect(conn.requestDisplay).not.toHaveBeenCalled();
    });

    /**
     * The optimistic highlight is a guess. If the tapped monitor was unplugged
     * a moment earlier, the Mac answers with the display it actually switched
     * to — and that answer, not the tap, is what the row must show.
     */
    it('defers to what the Mac says it actually switched to', async () => {
      renderViewer();
      const conn = lastConn();
      await act(async () => {
        conn.cb.onDisplays?.(twoDisplays, 1);
      });

      fireEvent.press(screen.getByTestId('display-2'));
      expect(screen.getByTestId('display-2').props.accessibilityState).toMatchObject({
        selected: true,
      });

      await act(async () => {
        conn.cb.onDisplays?.(twoDisplays, 1); // the Mac stayed on the built-in
      });
      expect(screen.getByTestId('display-2').props.accessibilityState).toMatchObject({
        selected: false,
      });
      expect(screen.getByTestId('display-1').props.accessibilityState).toMatchObject({
        selected: true,
      });
    });

    /** Looking at the other monitor is exactly as useful without control. */
    it('is offered in a view-only session too', async () => {
      renderViewer(['view']);
      await act(async () => {
        lastConn().cb.onDisplays?.(twoDisplays, 1);
      });
      expect(screen.getByTestId('display-2')).toBeTruthy();
      expect(screen.queryByTestId('mode-toggle-text')).toBeNull();
    });

    it('drops the row again when the second monitor is unplugged', async () => {
      renderViewer();
      await act(async () => {
        lastConn().cb.onDisplays?.(twoDisplays, 1);
      });
      expect(screen.getByTestId('display-2')).toBeTruthy();

      await act(async () => {
        lastConn().cb.onDisplays?.([twoDisplays[0]!], 1);
      });
      expect(screen.queryByTestId('display-2')).toBeNull();
    });
  });

  describe('clipboard-update (Finding 6)', () => {
    it('writes an incoming clipboard update to the phone clipboard and shows a toast', async () => {
      renderViewer();
      await act(async () => {
        lastConn().cb.onClipboardUpdate('copied text');
      });

      expect(Clipboard.setString).toHaveBeenCalledWith('copied text');
      expect(screen.getByTestId('clipboard-toast')).toBeTruthy();
      expect(screen.getByText('Copied from Mac')).toBeTruthy();
    });

    it('dismisses the toast automatically after a couple seconds', async () => {
      jest.useFakeTimers();
      try {
        renderViewer();
        await act(async () => {
          lastConn().cb.onClipboardUpdate('copied text');
        });
        expect(screen.getByTestId('clipboard-toast')).toBeTruthy();

        act(() => {
          jest.advanceTimersByTime(2_100);
        });

        expect(screen.queryByTestId('clipboard-toast')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('revoked mid-session (backend force-ends the room, reason "revoked")', () => {
    it('forgets the stale local pairing and shows an "Access revoked" alert distinct from the generic ended copy', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const { navigation } = renderViewer(['view', 'control'], TEST_SAFE_AREA_METRICS, 'desktop-1');

      await act(async () => {
        lastConn().cb.onRevoked();
        lastConn().cb.onState('ended');
      });

      expect(forgetPair).toHaveBeenCalledWith('desktop-1');
      expect(alertSpy).toHaveBeenCalledWith(
        'Pairing ended',
        // "Ended", not "revoked". Three words used to mean this one act —
        // Revoke on the Mac, Forget on the phone, "Access revoked" here — and
        // a customer had no way to know they were the same thing.
        expect.stringContaining('pair again'),
        expect.arrayContaining([expect.objectContaining({ text: 'OK' })]),
      );
      // Not the same as a generic terminal state's copy — no double message.
      expect(screen.queryByText('Connection failed')).toBeNull();

      // Tapping the alert's OK button returns to the device list.
      const [, , buttons] = alertSpy.mock.calls[0];
      buttons?.[0]?.onPress?.();
      expect(navigation.popToTop).toHaveBeenCalled();

      alertSpy.mockRestore();
    });

    it('does not attempt to forget a pairing when desktopDeviceId is unavailable', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      renderViewer(['view', 'control'], TEST_SAFE_AREA_METRICS, undefined);

      await act(async () => {
        lastConn().cb.onRevoked();
      });

      expect(forgetPair).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalled();

      alertSpy.mockRestore();
    });
  });
});

describe('reconnecting after the laptop drops', () => {
  const { loadPairs } = jest.requireMock('../lib/pairs') as { loadPairs: jest.Mock };
  const { requestConnectForPair } = jest.requireMock('../lib/api') as {
    requestConnectForPair: jest.Mock;
  };

  // The module mocks outlive each test; without this the first test's
  // `requestConnectForPair` call is still recorded when the second asserts it never
  // happened — a green that would have meant nothing.
  beforeEach(() => {
    loadPairs.mockReset().mockResolvedValue([]);
    requestConnectForPair.mockReset();
  });

  /**
   * The room does not outlive the laptop leaving it. Once the desktop is
   * reaped its authorization record goes too, and every re-register earns
   * `unauthorized_room` — seen on production as three attempts in four
   * seconds, then nothing. Reconnect has to ring the laptop again, not retry
   * a room that cannot come back.
   */
  it('rings the laptop again and moves to the new room', async () => {
    loadPairs.mockResolvedValue([
      {
        desktopDeviceId: 'desktop-1',
        name: 'MacBook',
        apiBaseUrl: 'https://api.example',
        connectSecret: 'secret',
      },
    ]);
    requestConnectForPair.mockResolvedValue({
      roomId: 'room-2',
      signalingUrl: 'wss://api.example/ws',
      scopes: ['view', 'control'],
      desktopDeviceName: 'MacBook',
    });
    const { navigation } = renderViewer(['view', 'control'], TEST_SAFE_AREA_METRICS, 'desktop-1');

    act(() => lastConn().cb.onState('ended'));
    fireEvent.press(await screen.findByText('Reconnect'));

    await waitFor(() =>
      expect(requestConnectForPair).toHaveBeenCalledWith(
        expect.objectContaining({
          desktopDeviceId: 'desktop-1',
          apiBaseUrl: 'https://api.example',
          connectSecret: 'secret',
        }),
      ),
    );
    // `replace`: leaving the dead room in the stack means Back returns to a
    // session that can only fail.
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        'Viewer',
        expect.objectContaining({ roomId: 'room-2', desktopDeviceId: 'desktop-1' }),
      ),
    );
  });

  /**
   * The mirror of the laptop-list bug, pointing the other way.
   *
   * Reconnect dropped the pin entirely while `requestConnectForPair` was
   * perfectly able to hand it a LAN URL — so a Reconnect that resolved to the
   * LAN opened an unpinned socket against a self-signed certificate, which is a
   * deterministic failure rather than an intermittent one. Both directions are
   * fixed by the same rule: carry the pin the ring returned, and nothing else.
   */
  it('carries the pin into the new room when the ring resolved to the LAN', async () => {
    loadPairs.mockResolvedValue([
      {
        desktopDeviceId: 'desktop-1',
        name: 'MacBook',
        apiBaseUrl: 'https://api.example',
        connectSecret: 'secret',
        lanTlsCertSha256: 'a'.repeat(64),
      },
    ]);
    requestConnectForPair.mockResolvedValue({
      roomId: 'room-lan',
      signalingUrl: 'wss://192.168.1.10:8787/ws/signal',
      scopes: ['view', 'control'],
      desktopDeviceName: 'MacBook',
      signalingTlsPin: 'a'.repeat(64),
    });
    const { navigation } = renderViewer(['view', 'control'], TEST_SAFE_AREA_METRICS, 'desktop-1');

    act(() => lastConn().cb.onState('ended'));
    fireEvent.press(await screen.findByText('Reconnect'));

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        'Viewer',
        expect.objectContaining({
          signalingUrl: 'wss://192.168.1.10:8787/ws/signal',
          signalingTlsPin: 'a'.repeat(64),
        }),
      ),
    );
  });

  /** …and the cloud half of the same rule: the pair's pin exists, the ring
   * fell back to cloud, so nothing is pinned. */
  it('does not carry a pin into a cloud room', async () => {
    loadPairs.mockResolvedValue([
      {
        desktopDeviceId: 'desktop-1',
        name: 'MacBook',
        apiBaseUrl: 'https://api.example',
        connectSecret: 'secret',
        lanTlsCertSha256: 'a'.repeat(64),
      },
    ]);
    requestConnectForPair.mockResolvedValue({
      roomId: 'room-cloud',
      signalingUrl: 'wss://api.example/ws/signal',
      scopes: ['view'],
      desktopDeviceName: 'MacBook',
    });
    const { navigation } = renderViewer(['view'], TEST_SAFE_AREA_METRICS, 'desktop-1');

    act(() => lastConn().cb.onState('ended'));
    fireEvent.press(await screen.findByText('Reconnect'));

    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    expect(navigation.replace.mock.calls[0][1].signalingTlsPin).toBeUndefined();
  });

  it('falls back to retrying in place when there is no secret to ring with', async () => {
    // A QR session for a laptop this phone never saved. There is nothing to
    // ring with, so the in-place retry — and the instruction to scan again —
    // is all that is left.
    loadPairs.mockResolvedValue([]);
    const { navigation } = renderViewer(['view'], TEST_SAFE_AREA_METRICS, 'desktop-unknown');

    act(() => lastConn().cb.onState('ended'));
    fireEvent.press(await screen.findByText('Reconnect'));

    await waitFor(() => expect(loadPairs).toHaveBeenCalled());
    expect(requestConnectForPair).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
