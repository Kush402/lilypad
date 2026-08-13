import type { QrPayload, SessionScope } from '@lilypad/protocol';

/** React Navigation route params. */
export type RootStackParamList = {
  Devices: undefined;
  Scanner: undefined;
  /**
   * Sign in (P1). `apiBaseUrl` is REQUIRED and always comes from something the
   * phone has already seen — a scanned code or a stored pair. The app ships no
   * default backend address, so there is no "sign in first, then find your
   * computer" path: the computer's code is what tells the phone where Lilypad
   * lives.
   */
  SignIn: { apiBaseUrl: string };
  Viewer: {
    /** Present for QR-scanned sessions; absent for trusted no-QR reconnects
     * (the Viewer itself only reads the fields below). */
    payload?: QrPayload;
    roomId: string;
    signalingUrl: string;
    scopes: SessionScope[];
    desktopDeviceName: string | null;
    /** The desktop's wire deviceId — so the Viewer can persist the connect
     * secret the backend delivers against the right saved pair (M5.4). */
    desktopDeviceId?: string;
  };
};
