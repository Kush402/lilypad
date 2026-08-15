import type { QrPayload, SessionScope } from '@lilypad/protocol';

/** React Navigation route params. */
export type RootStackParamList = {
  Devices: undefined;
  Scanner: undefined;
  /**
   * Sign in (P1, reordered in P3). `apiBaseUrl` is now OPTIONAL: the app ships
   * a default backend (`config/backend.ts`), which is what lets sign-in be the
   * first screen rather than something the scanner pushes on failure. It is
   * still passed explicitly when a scanned code named a different server, so
   * self-hosting keeps working exactly as before.
   */
  SignIn: { apiBaseUrl?: string } | undefined;
  /**
   * The ACCOUNT's devices (P2) — distinct from `Devices`, which lists the
   * laptops this phone has paired with. Optional for the same reason as
   * `SignIn`.
   */
  AccountDevices: { apiBaseUrl?: string } | undefined;
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
