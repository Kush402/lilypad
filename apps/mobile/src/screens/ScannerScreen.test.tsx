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

function renderScanner() {
  return render(
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Scanner" component={ScannerScreen} />
        <Stack.Screen name="Viewer" component={ViewerStub} />
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
