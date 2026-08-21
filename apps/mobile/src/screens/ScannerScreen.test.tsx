import React from 'react';
import { Linking } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { encodeQrPayload } from '@lilypad/protocol';
import { ScannerScreen } from './ScannerScreen';
import { redeemToken } from '../lib/api';
import { RedeemError, appError } from '../lib/errors';
import type { RootStackParamList } from '../types';

jest.mock('react-native-vision-camera', () => {
  const ReactActual = jest.requireActual('react');
  return {
    Camera: Object.assign((props: any) => ReactActual.createElement('Camera', props), {
      getCameraPermissionStatus: jest.fn(() => 'granted'),
      requestCameraPermission: jest.fn(async () => 'granted'),
    }),
    useCameraDevice: jest.fn(() => ({ id: 'back-camera' })),
    useCodeScanner: jest.fn((opts: any) => opts),
  };
});

jest.mock('../lib/api', () => ({ redeemToken: jest.fn() }));
jest.mock('../lib/auth', () => {
  class DeviceAuthError extends Error {
    constructor() {
      super('This phone is not signed in yet.');
      this.name = 'DeviceAuthError';
    }
  }
  return { approveDesktopEnrollment: jest.fn(), DeviceAuthError };
});
jest.mock('../lib/pairs', () => ({ upsertPair: jest.fn().mockResolvedValue(undefined) }));

const { Camera } = jest.requireMock('react-native-vision-camera') as {
  Camera: { getCameraPermissionStatus: jest.Mock; requestCameraPermission: jest.Mock };
};
const { useCodeScanner } = jest.requireMock('react-native-vision-camera') as {
  useCodeScanner: jest.Mock;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function ViewerStub() {
  const ReactActual = jest.requireActual('react');
  return ReactActual.createElement('Text', null, 'viewer-screen');
}

function SignInStub() {
  const ReactActual = jest.requireActual('react');
  return ReactActual.createElement('Text', null, 'sign-in-screen');
}

function DevicesStub() {
  const ReactActual = jest.requireActual('react');
  return ReactActual.createElement('Text', null, 'devices-screen');
}

function renderScanner() {
  return render(
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName="Scanner">
        <Stack.Screen name="Devices" component={DevicesStub} />
        <Stack.Screen name="Scanner" component={ScannerScreen} />
        <Stack.Screen name="Viewer" component={ViewerStub} />
        <Stack.Screen name="SignIn" component={SignInStub} />
      </Stack.Navigator>
    </NavigationContainer>,
  );
}

function scan(value: string) {
  const opts = useCodeScanner.mock.calls[useCodeScanner.mock.calls.length - 1][0];
  act(() => {
    opts.onCodeScanned([{ value, type: 'qr' }]);
  });
}

const VALID_QR = encodeQrPayload({
  v: 2,
  token: 'a'.repeat(20),
  roomId: 'room-12345678',
  apiBaseUrl: 'http://192.168.1.50:4000',
  signalingUrl: 'ws://192.168.1.50:4000/ws/signal',
  deviceName: "Kush's MacBook Pro",
  platform: 'macos',
});

describe('ScannerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Camera.getCameraPermissionStatus.mockReturnValue('granted');
    Camera.requestCameraPermission.mockResolvedValue('granted');
  });

  describe('camera permission flow', () => {
    it('shows a pre-permission explainer (not the OS dialog) when not-determined', async () => {
      Camera.getCameraPermissionStatus.mockReturnValue('not-determined');
      renderScanner();

      expect(screen.getByText(/needs your camera/i)).toBeTruthy();
      expect(Camera.requestCameraPermission).not.toHaveBeenCalled();

      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(Camera.requestCameraPermission).toHaveBeenCalled());
    });

    it('makes Open Settings the primary action once hard-denied, with no dead Grant button', async () => {
      Camera.getCameraPermissionStatus.mockReturnValue('denied');
      const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      renderScanner();

      expect(screen.queryByText('Grant camera access')).toBeNull();
      fireEvent.press(screen.getByText('Open Settings'));
      expect(openSettingsSpy).toHaveBeenCalled();
    });
  });

  describe('device identity at the confirmation card', () => {
    it('shows the desktop device name instead of a raw room UUID/URL', async () => {
      renderScanner();
      scan(VALID_QR);

      expect(await screen.findByText(/Pair with Kush's MacBook Pro\?/)).toBeTruthy();
      expect(screen.queryByText(/192\.168\.1\.50/)).toBeNull();

      fireEvent.press(screen.getByText('Show technical details'));
      expect(screen.getByText(/192\.168\.1\.50/)).toBeTruthy();
    });

    it('shows a generic error for an unparsable code without ever reaching the card', () => {
      renderScanner();
      scan('not json at all');

      expect(screen.getByText(/not a Lilypad pairing code/)).toBeTruthy();
      expect(screen.queryByText(/Pair with/)).toBeNull();
    });
  });

  describe('connect + error taxonomy', () => {
    it('navigates to Viewer on a successful redeem', async () => {
      jest.mocked(redeemToken).mockResolvedValue({
        roomId: 'room-1',
        signalingUrl: 'ws://x',
        scopes: ['view', 'control'],
        desktopDeviceName: "Kush's MacBook Pro",
      });
      renderScanner();
      scan(VALID_QR);
      fireEvent.press(await screen.findByText('Connect'));

      expect(await screen.findByText('viewer-screen')).toBeTruthy();
    });

    it('shows classified, human copy for a token_expired error and disables retry', async () => {
      jest.mocked(redeemToken).mockRejectedValue(new RedeemError(appError('token_expired')));
      renderScanner();
      scan(VALID_QR);
      fireEvent.press(await screen.findByText('Connect'));

      expect(await screen.findByText(/expired/i)).toBeTruthy();
      // Non-retryable: re-tapping Connect against the same burned token must
      // not fire a second redeem — the only way forward is Rescan for a
      // fresh code.
      fireEvent.press(screen.getByText('Connect'));
      expect(redeemToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('rescan race condition (Finding 7)', () => {
    it('does not navigate on a slow redeem that resolves after Cancel was tapped', async () => {
      let resolveRedeem!: (v: any) => void;
      jest.mocked(redeemToken).mockReturnValue(
        new Promise((resolve) => {
          resolveRedeem = resolve;
        }),
      );
      renderScanner();
      scan(VALID_QR);
      fireEvent.press(await screen.findByText('Connect'));

      // User backs out while the redeem is still in flight.
      fireEvent.press(screen.getByText('Cancel'));

      await act(async () => {
        resolveRedeem({
          roomId: 'room-1',
          signalingUrl: 'ws://x',
          scopes: ['view'],
          desktopDeviceName: 'x',
        });
        await Promise.resolve();
      });

      expect(screen.queryByText('viewer-screen')).toBeNull();
      // Back at the live scanner, not stuck mid-connect.
      expect(screen.queryByText('Cancel')).toBeNull();
    });

    it('aborts the in-flight request signal when the user cancels', async () => {
      const abortedSignals: AbortSignal[] = [];
      jest.mocked(redeemToken).mockImplementation(
        (_url, _token, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
            if (signal) abortedSignals.push(signal);
          }),
      );
      renderScanner();
      scan(VALID_QR);
      fireEvent.press(await screen.findByText('Connect'));
      fireEvent.press(screen.getByText('Cancel'));

      expect(abortedSignals[0]?.aborted).toBe(true);
    });
  });
});

/**
 * P1 — one camera, two codes, and the user must be able to tell which act they
 * just agreed to ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * Pairing starts one session. Linking hands a computer to an account
 * permanently. Presenting them identically would be the product's most
 * consequential ambiguity.
 */
describe('ScannerScreen — linking a computer to an account', () => {
  const LINK_QR = JSON.stringify({
    v: 1,
    kind: 'desktop-enrollment',
    code: 'c'.repeat(24),
    apiBaseUrl: 'http://192.168.1.50:4000',
    deviceName: "Kush's MacBook Pro",
    platform: 'macos',
  });

  const { approveDesktopEnrollment, DeviceAuthError } = jest.requireMock('../lib/auth') as {
    approveDesktopEnrollment: jest.Mock;
    DeviceAuthError: new () => Error;
  };
  const { upsertPair } = jest.requireMock('../lib/pairs') as { upsertPair: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    Camera.getCameraPermissionStatus.mockReturnValue('granted');
  });

  it('asks to ADD THE COMPUTER, never to pair, for a link code', () => {
    renderScanner();
    scan(LINK_QR);

    expect(screen.getByTestId('link-confirm')).toBeTruthy();
    expect(screen.getByText(/Add Kush's MacBook Pro to your account\?/)).toBeTruthy();
    expect(screen.queryByTestId('pair-confirm')).toBeNull();
    expect(screen.queryByText('Connect')).toBeNull();
  });

  it('still asks to PAIR for a pairing code', () => {
    renderScanner();
    scan(VALID_QR);

    expect(screen.getByTestId('pair-confirm')).toBeTruthy();
    expect(screen.queryByTestId('link-confirm')).toBeNull();
  });

  it('stores the one-time connect secret so the computer is reachable, not merely owned', async () => {
    approveDesktopEnrollment.mockResolvedValue({
      ok: true,
      // The two ids the backend returns, and they are NOT interchangeable:
      // `deviceId` is `devices.id`, an internal uuid; `desktopDeviceId` is
      // `devices.fingerprint`, the wire id `/connect/request` resolves.
      deviceId: '3c927336-81f0-4564-b7d6-1fe58e053795',
      desktopDeviceId: 'desktop-b31d4eed-d318-4e37-ba08-9a1f76349290',
      name: 'MacBook Pro',
      platform: 'macos',
      pairSecret: 'a-one-time-secret',
    });

    renderScanner();
    scan(LINK_QR);
    fireEvent.press(screen.getByText('Add computer'));

    await waitFor(() => expect(screen.getByTestId('link-done')).toBeTruthy());
    expect(approveDesktopEnrollment).toHaveBeenCalledWith(
      'http://192.168.1.50:4000',
      'c'.repeat(24),
    );
    // Storing the uuid here is the regression: every later Connect then said
    // "this laptop hasn't trusted this phone" about a live pairing, and every
    // Forget answered ok while severing nothing. The old fixture hid it by
    // calling the uuid `'desktop-uuid'`, which reads like a wire id.
    expect(upsertPair).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopDeviceId: 'desktop-b31d4eed-d318-4e37-ba08-9a1f76349290',
        connectSecret: 'a-one-time-secret',
      }),
    );
  });

  it('remembers nothing rather than a key that rings nothing', async () => {
    // An older backend omits `desktopDeviceId`. The laptop is still linked —
    // that is the account's business and already done — but this phone has no
    // id it could ring, and storing the uuid to fill the gap is precisely the
    // bug above.
    approveDesktopEnrollment.mockResolvedValue({
      ok: true,
      deviceId: '3c927336-81f0-4564-b7d6-1fe58e053795',
      name: 'MacBook Pro',
      platform: 'macos',
      pairSecret: 'a-one-time-secret',
    });

    renderScanner();
    scan(LINK_QR);
    fireEvent.press(screen.getByText('Add computer'));

    await waitFor(() => expect(screen.getByTestId('link-done')).toBeTruthy());
    expect(upsertPair).not.toHaveBeenCalled();
  });

  // Linking is not connecting. Owning a computer and choosing to control it
  // are separate acts, and the success screen must not blur them.
  it('does not start a session on success', async () => {
    approveDesktopEnrollment.mockResolvedValue({
      ok: true,
      deviceId: '3c927336-81f0-4564-b7d6-1fe58e053795',
      name: 'MacBook Pro',
      platform: 'macos',
      pairSecret: 's',
    });

    renderScanner();
    scan(LINK_QR);
    fireEvent.press(screen.getByText('Add computer'));

    await waitFor(() => expect(screen.getByTestId('link-done')).toBeTruthy());
    expect(screen.queryByText('viewer-screen')).toBeNull();
    expect(redeemToken).not.toHaveBeenCalled();
  });

  // The app ships no default backend address, so "sign in first" is not a
  // path that exists — the code is what tells the phone where Lilypad is.
  it('sends an unsigned-in phone to sign in, at the address the code named', async () => {
    approveDesktopEnrollment.mockRejectedValue(new DeviceAuthError());

    renderScanner();
    scan(LINK_QR);
    fireEvent.press(screen.getByText('Add computer'));

    await waitFor(() => expect(screen.getByText('sign-in-screen')).toBeTruthy());
  });

  it('shows a link failure without pretending the computer was added', async () => {
    approveDesktopEnrollment.mockRejectedValue(new Error('That code has expired.'));

    renderScanner();
    scan(LINK_QR);
    fireEvent.press(screen.getByText('Add computer'));

    await waitFor(() => expect(screen.queryByTestId('link-done')).toBeNull());
    expect(screen.getByTestId('link-confirm')).toBeTruthy();
  });
});
