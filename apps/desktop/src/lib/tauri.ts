import { invoke } from '@tauri-apps/api/core';

/** Mirrors the Rust QrPayloadDto returned by `create_pairing`. */
export interface QrPayloadDto {
  v: number;
  token: string;
  roomId: string;
  apiBaseUrl: string;
  signalingUrl: string;
  expiresInSeconds: number;
  deviceName: string;
  platform: string;
}

export type SessionStatus = 'idle' | 'pairing' | 'awaiting_approval' | 'active';

/** Mirrors the Rust `PendingRequest` — populated while `session ===
 * 'awaiting_approval'`, so the approve screen can show who's asking and for
 * what instead of a fixed sentence. */
export interface PendingRequestDto {
  device_name: string | null;
  requested_scopes: string[];
  /** Epoch milliseconds. */
  requested_at: number;
}

/** Mirrors the Rust AppStateDto returned by `get_state`. */
export interface AppStateDto {
  device_id: string;
  backend_base_url: string;
  session: SessionStatus;
  current_room_id: string | null;
  pending_request: PendingRequestDto | null;
  plugin_health: Record<string, string>;
}

export const api = {
  getState: () => invoke<AppStateDto>('get_state'),
  createPairing: () => invoke<QrPayloadDto>('create_pairing'),
  showQrWindow: () => invoke<void>('show_qr_window'),
  /** DEV-only (M1): stand in for a phone redeeming the token. Refuses in
   * release builds server-side too (see `commands::simulate_pair_request`). */
  simulatePairRequest: () => invoke<void>('simulate_pair_request'),
  approve: () => invoke<void>('approve_session'),
  deny: () => invoke<void>('deny_session'),
  disconnect: () => invoke<void>('disconnect'),
  panic: () => invoke<void>('panic_disconnect'),
};
