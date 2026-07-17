import type { QrPayload, SessionScope } from '@lilypad/protocol';

/** React Navigation route params. */
export type RootStackParamList = {
  Devices: undefined;
  Scanner: undefined;
  Viewer: {
    payload: QrPayload;
    roomId: string;
    signalingUrl: string;
    scopes: SessionScope[];
    desktopDeviceName: string | null;
  };
};
