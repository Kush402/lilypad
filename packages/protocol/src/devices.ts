import { z } from 'zod';
import { DeviceKindSchema, PlatformSchema } from './pairing.js';
import { DeviceStateSchema } from './identity.js';

/**
 * REST contract for account device management (P2).
 *
 * **This is a different list from `/devices/pairs`, and the distinction is the
 * product's ([ADR-0010](../../../docs/adr/0010-explicit-device-linking.md)):**
 *
 * - `/devices/pairs` — which PHONE may reach which LAPTOP. A relationship
 *   between two machines, established by the QR ceremony.
 * - `/devices` (here) — which machines belong to YOUR ACCOUNT. Ownership.
 *
 * Both exist because they answer different questions, and the linking ceremony
 * establishes both. Revoking here withdraws ownership, which is strictly
 * stronger than severing one pairing: the device can no longer authenticate at
 * all, and every live session it holds ends immediately.
 */

/** One device on the account, as `GET /devices` returns it. */
export const AccountDeviceSchema = z.object({
  /** `devices.id` — the server-side uuid, not the self-asserted wire id. */
  id: z.string().uuid(),
  kind: DeviceKindSchema,
  platform: PlatformSchema.nullable(),
  /** The label the user sees. Supplied by the device at enrollment and
   * renameable here; never an authorization input. */
  name: z.string().nullable(),
  /** Masked — enough to tell two unnamed devices apart, not enough to be worth
   * knowing. The full fingerprint is an input to the pairing surface, so
   * listing it in full would hand every reader of this response something the
   * ownership rules exist to make useless. */
  fingerprint: z.string(),
  state: DeviceStateSchema,
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  /** Whether this device is in a live session RIGHT NOW, from the signaling
   * hub rather than a table — the `sessions` table is not written yet, and an
   * empty table rendered as "no active sessions" would be a lie rather than a
   * gap. Single-instance truth; see OPS-1. */
  activeSession: z.boolean(),
  /** True for the device making the request, so a client can label it "this
   * phone" and warn before revoking the thing it is holding. */
  isCurrentDevice: z.boolean(),
});
export type AccountDevice = z.infer<typeof AccountDeviceSchema>;

export const AccountDeviceListSchema = z.object({
  devices: z.array(AccountDeviceSchema),
});
export type AccountDeviceList = z.infer<typeof AccountDeviceListSchema>;

export const DeviceIdParamsSchema = z.object({
  deviceId: z.string().uuid(),
});

/** Rename a device. The name is a human label and nothing authorizes on it. */
export const DeviceRenameSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type DeviceRename = z.infer<typeof DeviceRenameSchema>;
