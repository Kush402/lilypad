import { z } from 'zod';

/**
 * LAN control-plane constants ([ADR-0006](../../../docs/adr/0006-lan-first-connectivity.md),
 * [NETWORKING.md](../../../docs/NETWORKING.md)).
 *
 * The laptop serves the same `@lilypad/protocol` contract locally so a session
 * on the same network never needs the cloud control plane.
 */

/** TCP port for the desktop's embedded LAN control server (REST + `/ws/signal`). */
export const LAN_CONTROL_PORT = 8787 as const;

/** Bonjour / mDNS service type for secondary discovery (step 2 in NETWORKING §3). */
export const LAN_MDNS_SERVICE = '_lilypad._tcp.local' as const;

/** Budget before falling through to the cloud path (NETWORKING §3). */
export const LAN_PROBE_BUDGET_MS = 1500 as const;

/** Where the phone reaches this laptop's local control plane. */
export const LanEndpointsSchema = z.object({
  apiBaseUrl: z.string().url(),
  signalingUrl: z.string().min(1),
  /** SHA-256 (hex) of the DER TLS certificate — pinned at first use. */
  tlsCertSha256: z.string().length(64).regex(/^[0-9a-f]+$/),
});
export type LanEndpoints = z.infer<typeof LanEndpointsSchema>;
