import { z } from 'zod';
import { SessionScopeSchema, DeviceKindSchema } from './pairing.js';

/**
 * Signaling protocol — JSON over WebSocket (`/ws/signal`), room-routed by
 * `roomId`. The backend relays offer/answer/ICE between the two peers in a room
 * and brokers the approve/deny handshake. It never touches media.
 *
 * Every message shares an envelope: { type, roomId, from, ts, payload }.
 */

/** One ICE server entry handed to the peers to build RTCPeerConnection. */
export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServerSchema>;

// Length bounds are defense-in-depth against oversized frames (the WS layer
// also caps total payload). A real SDP is a few KB; ICE candidates are short.
const MAX_SDP_LEN = 32 * 1024;
const MAX_CANDIDATE_LEN = 2 * 1024;
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 256;
const MAX_REASON_LEN = 512;
/** Generous for real clipboard text (a URL, a code snippet, a paragraph);
 * rejects pathological oversized payloads rather than truncating (a silently
 * truncated clipboard sync is worse than a rejected one). */
const MAX_CLIPBOARD_LEN = 64 * 1024;

const SdpSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().max(MAX_SDP_LEN),
});

const IceCandidateSchema = z.object({
  candidate: z.string().max(MAX_CANDIDATE_LEN),
  sdpMid: z.string().max(MAX_ID_LEN).nullable().optional(),
  // An SDP m-line index is never negative and (per the desktop's Rust mirror,
  // which stores it as a u16) never exceeds 65535 — bounding it here means a
  // malformed/hostile value is rejected at the backend's validation boundary
  // instead of merely failing to deserialize downstream in Rust.
  sdpMLineIndex: z.number().int().min(0).max(65_535).nullable().optional(),
});

/** Common envelope fields present on every signaling message. */
const envelope = {
  roomId: z.string().min(1).max(MAX_ID_LEN),
  /** Sender identity within the room. */
  from: DeviceKindSchema,
  /** Milliseconds since epoch, stamped by the sender. */
  ts: z.number().int().nonnegative(),
};

const register = z.object({
  type: z.literal('register'),
  ...envelope,
  payload: z.object({
    role: DeviceKindSchema,
    deviceId: z.string().min(8).max(MAX_ID_LEN),
    /**
     * Process-death rejoin of a live room. The hub re-issues `session-start`
     * so both peers mint a new WebRTC transport. Mid-session socket flaps
     * omit this — media is still flowing and a fresh session-start would
     * tear it down.
     */
    rejoin: z.boolean().optional(),
  }),
});

const pairRequest = z.object({
  type: z.literal('pair-request'),
  ...envelope,
  payload: z.object({
    deviceId: z.string().min(8).max(MAX_ID_LEN),
    deviceName: z.string().max(MAX_NAME_LEN).nullable(),
    requestedScopes: z.array(SessionScopeSchema).max(8),
  }),
});

// Desktop → server: the user tapped Approve and grants these scopes. The server
// (not the desktop) mints the session id + ICE credentials, returned via
// `session-start` below.
const pairApproved = z.object({
  type: z.literal('pair-approved'),
  ...envelope,
  payload: z.object({
    grantedScopes: z.array(SessionScopeSchema),
    /** M5.4: the user also checked "Trust this device" — the backend records
     * a persistent desktop↔mobile pair (`trusted_devices`) enabling the
     * no-QR reconnect flow. Optional so pre-M5.4 desktops stay valid. */
    trust: z.boolean().optional(),
  }),
});

const pairDenied = z.object({
  type: z.literal('pair-denied'),
  ...envelope,
  payload: z.object({ reason: z.string().max(MAX_REASON_LEN).nullable() }),
});

const offer = z.object({
  type: z.literal('offer'),
  ...envelope,
  payload: SdpSchema,
});

const answer = z.object({
  type: z.literal('answer'),
  ...envelope,
  payload: SdpSchema,
});

const iceCandidate = z.object({
  type: z.literal('ice-candidate'),
  ...envelope,
  payload: IceCandidateSchema,
});

// Server → both peers: the session is live. Carries the server-minted session
// id, the granted scopes, and per-peer ICE servers (STUN + time-limited TURN).
const sessionStart = z.object({
  type: z.literal('session-start'),
  ...envelope,
  payload: z.object({
    sessionId: z.string(),
    grantedScopes: z.array(SessionScopeSchema),
    iceServers: z.array(IceServerSchema),
    /** Server-controlled ICE transport policy for both peers'
     * `RTCPeerConnection`. `'relay'` forces relay-only ICE — both peers use
     * the deterministic single relayed path over the dedicated TURN server,
     * instead of risking a fragile direct `srflx↔srflx` pair that a CGNAT
     * rebind can break. Omitted/`'all'` = normal ICE (host/srflx/relay
     * candidates all considered), the default. */
    iceTransportPolicy: z.enum(['all', 'relay']).optional(),
  }),
});

const sessionEnd = z.object({
  type: z.literal('session-end'),
  ...envelope,
  payload: z.object({ reason: z.string().max(MAX_REASON_LEN).nullable() }),
});

const errorMsg = z.object({
  type: z.literal('error'),
  ...envelope,
  // Errors can be sent before a peer has joined a room, so roomId may be empty.
  roomId: z.string(),
  payload: z.object({ code: z.string(), message: z.string() }),
});

const ping = z.object({ type: z.literal('ping'), ...envelope, payload: z.object({}) });
const pong = z.object({ type: z.literal('pong'), ...envelope, payload: z.object({}) });

/** Keepalive: peers emit `heartbeat` on an interval; the hub reaps stale sockets. */
const heartbeat = z.object({
  type: z.literal('heartbeat'),
  ...envelope,
  payload: z.object({ seq: z.number().int().nonnegative().optional() }),
});

/** Temporarily stop the stream (phone backgrounded, user paused) without tearing down ICE. */
const pause = z.object({
  type: z.literal('pause'),
  ...envelope,
  payload: z.object({ reason: z.string().max(MAX_REASON_LEN).nullable().optional() }),
});

const resume = z.object({
  type: z.literal('resume'),
  ...envelope,
  payload: z.object({}),
});

/** Ask the desktop to produce a new offer (e.g. resolution/track change, ICE restart).
 * `rejoin: true` is a process-death resume: the phone has a new PeerConnection
 * (new DTLS fingerprint), so ICE-restart on the old desktop peer cannot work.
 * The hub re-issues `session-start` to both seats with fresh ICE instead of
 * relaying this as a restart request. */
const renegotiate = z.object({
  type: z.literal('renegotiate'),
  ...envelope,
  payload: z.object({
    reason: z.string().max(MAX_REASON_LEN).nullable().optional(),
    iceRestart: z.boolean().optional(),
    rejoin: z.boolean().optional(),
  }),
});

/** Graceful teardown initiated by either peer (or the desktop panic button). */
const disconnect = z.object({
  type: z.literal('disconnect'),
  ...envelope,
  payload: z.object({ reason: z.string().max(MAX_REASON_LEN).nullable().optional() }),
});

/** `Motion` = today's default (30fps, real-display-aware resolution capped
 * for bandwidth); `Text` = a lower frame rate traded for a higher resolution
 * ceiling, for reading dense static content (a code editor, a terminal, a
 * spreadsheet). See `docs/audit/m3/prior-art.md` Finding 2. */
export const CaptureModeSchema = z.enum(['motion', 'text']);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

/** A Mac can have several displays and Lilypad shows one of them at a time.
 * `id` is the OS's own `CGDirectDisplayID` — stable while the display stays
 * attached, which is exactly the lifetime of a session's use of it. The name
 * is what the phone puts on the button ("Built-in Display", "Display 2"). */
export const DisplayInfoSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1).max(64),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
});
export type DisplayInfo = z.infer<typeof DisplayInfoSchema>;

/** Nobody plugs sixteen monitors into a MacBook, and an unbounded array on a
 * wire message is a memory-shaped hole. */
const MAX_DISPLAYS = 16;

/**
 * Desktop → mobile: the current capture resolution, in pixels, and which
 * capture mode produced it. The phone renders the video letterboxed
 * (`objectFit: 'contain'`), so without knowing the source aspect ratio it
 * cannot map a touch onto the actual video content rect — it maps against
 * the whole view instead, and every touch lands in the wrong place whenever
 * the two aspect ratios differ (the common case). Sent once when the
 * pipeline starts and again on any resolution or mode change. See
 * `docs/audit/m3/input-touch.md` Finding 1 and
 * `docs/audit/m3/prior-art.md` Finding 2.
 */
const frameSize = z.object({
  type: z.literal('frame-size'),
  ...envelope,
  payload: z.object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
    mode: CaptureModeSchema,
    /** Every display attached to the Mac right now. Optional because a
     * desktop older than 0.1.10 sends none, and a phone that has updated
     * first must not reject its `frame-size` — the switcher simply stays
     * hidden, which is also what a single-display Mac shows. */
    displays: z.array(DisplayInfoSchema).max(MAX_DISPLAYS).optional(),
    /** Which of `displays` the video is currently showing. */
    activeDisplayId: z.number().int().nonnegative().optional(),
  }),
});

/**
 * Mobile → desktop: request a capture/encode mode switch (a UI toggle next
 * to the existing input toolbar). Unlike a bitrate retarget, this forces a
 * full capture+encoder rebuild on the desktop — expect a brief visible
 * glitch, which the mobile UI should communicate (e.g. a "Switching to Text
 * Mode…" toast) rather than leave silent. See
 * `docs/audit/m3/prior-art.md` Finding 2.
 */
const setCaptureMode = z.object({
  type: z.literal('set-capture-mode'),
  ...envelope,
  payload: z.object({ mode: CaptureModeSchema }),
});

/**
 * Mobile → desktop: show a different display. Same cost as a mode switch —
 * a full capture+encoder rebuild, since neither backend can be resized in
 * place — so the phone shows the same kind of brief "Switching…" feedback.
 *
 * An unknown or unplugged id is not an error: the desktop falls back to its
 * main display and reports what it actually did in the next `frame-size`,
 * which is the only thing the phone ever trusts about the current display.
 */
const setDisplay = z.object({
  type: z.literal('set-display'),
  ...envelope,
  payload: z.object({ displayId: z.number().int().nonnegative() }),
});

/**
 * Desktop → mobile: the desktop's OS clipboard changed. Phone→desktop
 * clipboard sync already exists via the `clipboard` input event (carried on
 * the DataChannel); this is the reverse direction on the same reliable,
 * encrypted channel. See kanban L-211 for the retired signaling transport.
 */
// The envelope is retained for wire compatibility, but v0.1.29 sends it only
// on the encrypted reliable DataChannel. Cloud/LAN signaling discard legacy
// clipboard frames; they are never a fallback for this private payload.
export const ClipboardUpdateSchema = z.object({
  type: z.literal('clipboard-update'),
  ...envelope,
  payload: z.object({ text: z.string().max(MAX_CLIPBOARD_LEN) }),
});

/**
 * Server → mobile: the per-pair connect secret, delivered over the mobile
 * seat right after a trusted approval (M5.4 security). The phone stores it
 * (keychain) and presents it on future `POST /connect/request` calls, so a
 * no-QR reconnect requires a real bearer credential — not just knowledge of
 * two self-asserted device-id strings. Only ever sent to the mobile seat.
 */
const pairSecret = z.object({
  type: z.literal('pair-secret'),
  ...envelope,
  payload: z.object({ secret: z.string().min(16).max(128) }),
});

/**
 * Server → desktop (presence room): a trusted phone asked to connect without
 * a QR (`POST /connect/request`). The desktop spawns its normal session
 * runner on `sessionRoomId`; everything downstream (pair-request, ring UI or
 * auto-approve, session-start, offer/answer) is the existing pairing flow.
 * Never accepted FROM a client (MessageRouter rejects it).
 */
const connectRequest = z.object({
  type: z.literal('connect-request'),
  ...envelope,
  payload: z.object({
    /** The fresh, room-auth-bound session room both devices will join. */
    sessionRoomId: z.string().min(1).max(MAX_ID_LEN),
    mobileDeviceId: z.string().min(8).max(MAX_ID_LEN),
    mobileDeviceName: z.string().max(MAX_NAME_LEN).nullable(),
    requestedScopes: z.array(SessionScopeSchema).max(8),
    /** The pair's desktop-side "Always allow" setting — the desktop skips the
     * ring and approves immediately (session indicator + audit still apply). */
    autoApprove: z.boolean(),
  }),
});

// Server → the REMAINING peer: its counterpart's signaling transport went
// offline (dropped, being held for the re-register grace) or came back online
// (re-registered within grace). Lets the remaining peer combine this with its
// own peer-to-peer media liveness to tell "counterpart genuinely gone" from
// "signaling blip while media still flows", instead of guessing from ICE alone.
const peerStatus = z.object({
  type: z.literal('peer-status'),
  ...envelope,
  payload: z.object({ online: z.boolean() }),
});

/**
 * Server → desktop (presence room): a trusted pair was just recorded. The
 * desktop caches the hash so its embedded LAN control plane can authorize
 * `POST /connect/request` without Postgres ([ADR-0006](../../../docs/adr/0006-lan-first-connectivity.md)).
 * Hash only — the plaintext secret stays on the phone.
 *
 * Incremental: one new or updated pair. Full authoritative replacement of the
 * LAN trust cache is `trust-sync` (omissions are revocations).
 */
const trustRecord = z.object({
  type: z.literal('trust-record'),
  ...envelope,
  payload: z.object({
    mobileDeviceId: z.string().min(8).max(MAX_ID_LEN),
    connectSecretHash: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]+$/),
    autoApprove: z.boolean(),
    displayName: z.string().max(MAX_NAME_LEN).nullable(),
  }),
});

/**
 * Server → desktop (presence room): the complete set of trusted phones for the
 * LAN trust cache. Replaces the cache wholesale — a phone omitted here is no
 * longer authorized to ring over the LAN, matching cloud revocation. Sent on
 * every presence rejoin and after a revoke/unpair while the desktop is seated.
 */
const trustSync = z.object({
  type: z.literal('trust-sync'),
  ...envelope,
  payload: z.object({
    records: z.array(
      z.object({
        mobileDeviceId: z.string().min(8).max(MAX_ID_LEN),
        connectSecretHash: z
          .string()
          .length(64)
          .regex(/^[0-9a-f]+$/),
        autoApprove: z.boolean(),
        displayName: z.string().max(MAX_NAME_LEN).nullable(),
      }),
    ),
  }),
});

/**
 * Desktop → mobile: where to reach this laptop's LAN control plane. Cached on
 * the phone as the primary reconnect path (NETWORKING §3 step 1).
 */
const lanEndpoints = z.object({
  type: z.literal('lan-endpoints'),
  ...envelope,
  payload: z.object({
    apiBaseUrl: z.string().url(),
    signalingUrl: z.string().min(1),
    tlsCertSha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]+$/),
  }),
});

export const SignalingMessageSchema = z.discriminatedUnion('type', [
  connectRequest,
  pairSecret,
  trustRecord,
  trustSync,
  lanEndpoints,
  register,
  pairRequest,
  pairApproved,
  pairDenied,
  offer,
  answer,
  iceCandidate,
  sessionStart,
  sessionEnd,
  errorMsg,
  ping,
  pong,
  heartbeat,
  pause,
  resume,
  renegotiate,
  disconnect,
  frameSize,
  ClipboardUpdateSchema,
  setCaptureMode,
  setDisplay,
  peerStatus,
]);
export type SignalingMessage = z.infer<typeof SignalingMessageSchema>;
export type SignalingType = SignalingMessage['type'];

/**
 * Reserved room namespace for desktop presence (M5.4). A desktop registers
 * into `presence:<its deviceId>` at launch so trusted phones can reach it
 * without a QR; the register gate authorizes the claim by suffix match (a
 * key signature once M5's device identity lands). Session rooms are always
 * UUIDs, so the namespace can never collide with a pairing room.
 */
export const PRESENCE_ROOM_PREFIX = 'presence:' as const;

export function presenceRoomId(deviceId: string): string {
  return `${PRESENCE_ROOM_PREFIX}${deviceId}`;
}

/** The owning deviceId if `roomId` is a presence room, else null. */
export function presenceRoomDeviceId(roomId: string): string | null {
  return roomId.startsWith(PRESENCE_ROOM_PREFIX) ? roomId.slice(PRESENCE_ROOM_PREFIX.length) : null;
}

export function encodeSignal(msg: SignalingMessage): string {
  return JSON.stringify(SignalingMessageSchema.parse(msg));
}

export function decodeSignal(raw: string): SignalingMessage {
  return SignalingMessageSchema.parse(JSON.parse(raw));
}
