/**
 * mDNS browse for `_lilypad._tcp` (NETWORKING.md §3 step 2).
 */
import { NativeModules } from 'react-native';
import { LAN_CONTROL_PORT } from '@lilypad/protocol';

const Native = NativeModules.LilypadLanTls as
  | {
      browseLilypad?: (
        desktopDeviceId: string,
        timeoutMs: number,
      ) => Promise<{ host: string; port: number; deviceId: string } | null>;
    }
  | undefined;

export type LanDiscoveryHit = {
  apiBaseUrl: string;
  signalingUrl: string;
};

/** Resolve a paired desktop via Bonjour when the cached IP moved. */
export async function discoverLanDesktop(
  desktopDeviceId: string,
  budgetMs: number,
): Promise<LanDiscoveryHit | null> {
  if (!Native?.browseLilypad) return null;
  try {
    const hit = await Native.browseLilypad(desktopDeviceId, budgetMs);
    if (!hit || hit === null || typeof hit !== 'object' || !('host' in hit)) return null;
    const port = hit.port || LAN_CONTROL_PORT;
    const host = hit.host;
    return {
      apiBaseUrl: `https://${host}:${port}`,
      signalingUrl: `wss://${host}:${port}/ws/signal`,
    };
  } catch {
    return null;
  }
}

export function mdnsBrowseAvailable(): boolean {
  return Native?.browseLilypad != null;
}
