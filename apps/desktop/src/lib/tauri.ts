import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

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

export type SessionStatus = 'idle' | 'pairing' | 'awaiting_approval' | 'connecting' | 'active';

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
  approve: (trust = false) => invoke<void>('approve_session', { trust }),
  deny: () => invoke<void>('deny_session'),
  disconnect: () => invoke<void>('disconnect'),
  panic: () => invoke<void>('panic_disconnect'),
  // Trusted devices dashboard (M5.4) — mirrors @lilypad/protocol's
  // TrustedPairListing via the backend's /devices/pairs endpoints.
  listTrustedDevices: () =>
    invoke<{ pairs: TrustedPairDto[] }>('list_trusted_devices').then((r) => r.pairs),
  setPairAutoApprove: (pairId: string, autoApprove: boolean) =>
    invoke<void>('set_pair_auto_approve', { pairId, autoApprove }),
  revokePair: (pairId: string) => invoke<void>('revoke_pair', { pairId }),
  getLoginItemEnabled: () => invoke<boolean>('get_login_item_enabled'),
  setLoginItemEnabled: (enabled: boolean) => invoke<void>('set_login_item_enabled', { enabled }),
  // Dashboard system panel — read-only status + an editor affordance.
  getPermissionStatus: () => invoke<PermissionStatusDto>('get_permission_status'),
  getAgentConfig: () => invoke<AgentConfigDto>('get_agent_config'),
  showSetup: () => invoke<void>('show_setup_window'),
  showControl: () => invoke<void>('show_control_window'),
};

/**
 * Automatic binary updates (M6) — a thin wrapper over
 * `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` so the update
 * flow is mockable through the same `vi.mock('../lib/tauri')` seam the rest of
 * the UI uses, instead of components importing the plugin SDKs directly.
 */
export type { Update };
export const updater = {
  /** The running app's version (from the bundle), e.g. "0.1.0". */
  currentVersion: () => getVersion(),
  /** Resolves to an `Update` when a newer signed release is available, else null. */
  check: () => check(),
  /** Quit and restart into the just-installed version. */
  relaunch: () => relaunch(),
};

/** Mirrors the Rust PermissionStatusDto. */
export interface PermissionStatusDto {
  screen_capture: boolean;
  accessibility: boolean;
}

/** Mirrors the Rust AgentConfigDto (Ask AI provider). */
export interface AgentConfigDto {
  providerKind: string | null;
  model: string | null;
  baseUrl: string | null;
  vision: boolean;
  hasKey: boolean;
  /** "env" | "settings" | "none" — which config source is active. */
  source: string;
}

/** One trusted phone, as the dashboard lists it. */
export interface TrustedPairDto {
  pairId: string;
  mobileFingerprint: string;
  displayName: string | null;
  autoApprove: boolean;
  revoked: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
}
