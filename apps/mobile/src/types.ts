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
   * The signed-out gate. Renders the same screen as `SignIn`, under a name that
   * **must not exist in the signed-in stack** — that is the whole point of it.
   *
   * React Navigation keeps a focused route across a conditional-screen swap
   * whenever its name still exists in the new configuration. While the gate was
   * also called `SignIn`, and `SignIn` legitimately stayed in the signed-in
   * stack (the scanner pushes it when a QR names a different backend), signing
   * in did nothing visible: the session flipped, the stack swapped, and the
   * navigator went on showing the very same route. A distinct name is what lets
   * the route disappear, which is what moves the user to `Devices`.
   */
  SignInGate: undefined;
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
    /**
     * SHA-256 pin the `signalingUrl` above must present (M9.5) — set only when
     * that URL is the laptop's LAN endpoint, absent for a cloud room.
     *
     * Named for the URL it belongs to rather than for the pair it came from.
     * It used to be `lanTlsCertSha256`, filled in from `pair.lanTlsCertSha256`
     * whatever the accompanying URL turned out to be, which is how a cloud
     * socket came to be pinned to a laptop's self-signed certificate and hung
     * on "Connecting…" forever (see `ConnectForPairResult` in `lib/api.ts`).
     * The only correct source is `requestConnectForPair`'s `signalingTlsPin`,
     * which is `undefined` unless the LAN target actually won.
     */
    signalingTlsPin?: string;
  };
};
