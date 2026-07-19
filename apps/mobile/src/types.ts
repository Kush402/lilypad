import type { QrPayload, SessionScope } from '@lilypad/protocol';

/** React Navigation route params. */
export type RootStackParamList = {
  Devices: undefined;
  Scanner: undefined;
  Viewer: {
    /** Present for QR-scanned sessions; absent for trusted no-QR reconnects
     * (the Viewer itself only reads the fields below). */
    payload?: QrPayload;
    roomId: string;
    signalingUrl: string;
    scopes: SessionScope[];
    desktopDeviceName: string | null;
  };
};
