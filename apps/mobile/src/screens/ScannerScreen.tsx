import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCodeScanner,
  type CameraPermissionStatus,
} from 'react-native-vision-camera';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { decodeScannedCode, type ScannedCode } from '@lilypad/protocol';
import type { RootStackParamList } from '../types';
import { redeemToken } from '../lib/api';
import { approveDesktopEnrollment, DeviceAuthError } from '../lib/auth';
import { upsertPair } from '../lib/pairs';
import { appError, toAppError, type AppError } from '../lib/errors';
import { theme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Scanner'>;

const PLATFORM_GLYPH: Record<string, string> = {
  macos: '🍎',
  windows: '🪟',
  linux: '🐧',
  ios: '📱',
  android: '📱',
};

/**
 * QR scanner (react-native-vision-camera).
 *
 * One camera, two codes a laptop can show, and the difference matters
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)):
 *
 * - **pair** — start a session with this laptop now. Redeems a single-use
 *   token and moves to the viewer.
 * - **link** — add this computer to your account (P1,
 *   [ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
 *   This is the higher-privilege act and needs a signed-in phone, so the
 *   screen says which one is about to happen rather than inferring it from
 *   how the user got here.
 */
export function ScannerScreen({ navigation }: Props) {
  const [permStatus, setPermStatus] = useState<CameraPermissionStatus>(() =>
    Camera.getCameraPermissionStatus(),
  );
  const device = useCameraDevice('back');
  const [scanned, setScanned] = useState<ScannedCode | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Bumped on every connect-start AND on Rescan/Cancel, so a slow redeemToken
  // resolving/rejecting after the user has already backed out is detectably
  // stale and never acted on. See docs/audit/m3/mobile-ux.md Finding 7.
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Re-read the granular permission status whenever the screen regains
  // focus — catches the user granting it from the Settings app and coming
  // back. See docs/audit/m3/mobile-ux.md Finding 6.
  useFocusEffect(
    useCallback(() => {
      setPermStatus(Camera.getCameraPermissionStatus());
    }, []),
  );

  const requestPermission = useCallback(async () => {
    await Camera.requestCameraPermission();
    setPermStatus(Camera.getCameraPermissionStatus());
  }, []);

  const onValue = useCallback(
    (value: string) => {
      if (scanned) return;
      try {
        setScanned(decodeScannedCode(value));
        setError(null);
      } catch {
        setError(appError('qr_invalid'));
      }
    },
    [scanned],
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      const v = codes[0]?.value;
      if (v) onValue(v);
    },
  });

  const connect = useCallback(async () => {
    if (scanned?.kind !== 'pair') return;
    const payload = scanned.payload;
    const myRequest = ++requestSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setConnecting(true);
    setError(null);
    try {
      const res = await redeemToken(payload.apiBaseUrl, payload.token, controller.signal);
      if (myRequest !== requestSeq.current) return; // superseded by Rescan/a later attempt
      // M5.4: remember this desktop so My Devices can ring it without a QR.
      // Fire-and-forget; an old backend without desktopDeviceId just isn't
      // rememberable (the session itself is unaffected either way).
      if (res.desktopDeviceId) {
        void upsertPair({
          desktopDeviceId: res.desktopDeviceId,
          name: res.desktopDeviceName ?? payload.deviceName ?? null,
          apiBaseUrl: payload.apiBaseUrl,
        }).catch(() => {});
      }
      navigation.replace('Viewer', {
        payload,
        roomId: res.roomId,
        signalingUrl: res.signalingUrl,
        scopes: res.scopes,
        desktopDeviceName: res.desktopDeviceName,
        desktopDeviceId: res.desktopDeviceId,
      });
    } catch (e) {
      if (myRequest !== requestSeq.current) return;
      setError(toAppError(e));
      setConnecting(false);
    }
  }, [scanned, navigation]);

  /**
   * Add this computer to THIS phone's account (P1).
   *
   * The account it joins is the subject of this phone's device token and
   * nothing in the code — so a phone that is not signed in cannot link
   * anything, and the error says exactly that instead of failing vaguely.
   * Linking does not start a session: the laptop is now the user's, and
   * connecting to it is still a separate, deliberate act.
   */
  const link = useCallback(async () => {
    if (scanned?.kind !== 'link') return;
    const payload = scanned.payload;
    const myRequest = ++requestSeq.current;
    setConnecting(true);
    setError(null);
    try {
      const res = await approveDesktopEnrollment(payload.apiBaseUrl, payload.code);
      if (myRequest !== requestSeq.current) return;
      // The connect secret is delivered exactly once and is never stored in
      // plaintext server-side. Persisting the pair here is what turns "this
      // laptop is mine" into "and I can reach it without another QR".
      //
      // `desktopDeviceId`, NOT `deviceId`: the latter is the backend's
      // internal `devices.id` uuid, and storing it here as the wire id is
      // what made every later Connect answer "this laptop hasn't trusted this
      // phone" about a pairing that was live, and every Forget silently sever
      // nothing. An older backend omits the field; without it the laptop is
      // linked but not rememberable, so say so rather than store a key that
      // rings nothing.
      if (res.desktopDeviceId) {
        void upsertPair({
          desktopDeviceId: res.desktopDeviceId,
          name: res.name ?? payload.deviceName,
          apiBaseUrl: payload.apiBaseUrl,
          connectSecret: res.pairSecret,
        }).catch(() => {});
      }
      setLinked(res.name ?? payload.deviceName ?? 'That computer');
      setConnecting(false);
    } catch (e) {
      if (myRequest !== requestSeq.current) return;
      setConnecting(false);
      // The one failure with a specific remedy: this phone has no account yet.
      // Sign-in is pushed ON TOP, so coming back finds this card still here
      // with the same code — the user resumes rather than re-scans. The
      // address comes from the code itself; the app ships no default backend.
      if (e instanceof DeviceAuthError) {
        navigation.navigate('SignIn', { apiBaseUrl: payload.apiBaseUrl });
        return;
      }
      setError(toAppError(e));
    }
  }, [scanned, navigation]);

  // Shared by "Rescan" (idle) and "Cancel" (mid-connect, same button
  // relabeled): invalidate any in-flight redeem, actually abort its network
  // request, and return to the live scanner.
  const cancelOrRescan = useCallback(() => {
    requestSeq.current += 1;
    abortRef.current?.abort();
    setConnecting(false);
    setScanned(null);
    setError(null);
    setLinked(null);
  }, []);

  if (permStatus === 'not-determined') {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>
          Lilypad needs your camera to scan the QR code shown on your laptop. We never store or
          upload anything from your camera.
        </Text>
        <Pressable style={styles.primary} onPress={() => void requestPermission()}>
          <Text style={styles.primaryText}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  if (permStatus === 'denied' || permStatus === 'restricted') {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>
          Camera access was denied. Enable it in Settings to scan a pairing QR code.
        </Text>
        <Pressable style={styles.primary} onPress={() => void Linking.openSettings()}>
          <Text style={styles.primaryText}>Open Settings</Text>
        </Pressable>
        <Pressable onPress={() => void requestPermission()}>
          <Text style={styles.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>No camera available on this device.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!scanned}
        codeScanner={codeScanner}
      />
      <View style={styles.reticle} pointerEvents="none" />

      {!scanned ? (
        <View style={styles.hint}>
          <Text style={styles.hintText}>Point at the QR shown on your laptop</Text>
          {error ? <Text style={styles.error}>{error.message}</Text> : null}
        </View>
      ) : linked !== null ? (
        <View style={styles.card} testID="link-done">
          <Text style={styles.cardTitle}>{linked} is now on your account</Text>
          <Text style={styles.cardMeta}>
            It appears under Your laptops. Connecting to it is still a separate step.
          </Text>
          <View style={styles.row}>
            <Pressable
              style={[styles.primary, styles.flex]}
              onPress={() => navigation.navigate('Devices')}
            >
              <Text style={styles.primaryText}>Done</Text>
            </Pressable>
          </View>
        </View>
      ) : scanned.kind === 'link' ? (
        <View style={styles.card} testID="link-confirm">
          {/* Named deliberately differently from pairing. Linking hands a
              computer to an account permanently; pairing starts one session.
              A user must be able to tell which they just agreed to. */}
          <Text style={styles.cardTitle}>
            {scanned.payload.platform ? `${PLATFORM_GLYPH[scanned.payload.platform] ?? ''} ` : ''}
            Add {scanned.payload.deviceName ?? 'this computer'} to your account?
          </Text>
          <Text style={styles.cardMeta}>
            It becomes yours: only your account can see, reach or revoke it.
          </Text>
          {error ? <Text style={styles.error}>{error.message}</Text> : null}
          <View style={styles.row}>
            <Pressable
              style={[styles.primary, styles.flex]}
              onPress={() => void link()}
              disabled={connecting || (!!error && !error.retryable)}
            >
              {connecting ? (
                <ActivityIndicator color={theme.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Add computer</Text>
              )}
            </Pressable>
            <Pressable style={[styles.ghost, styles.flex]} onPress={cancelOrRescan}>
              <Text style={styles.ghostText}>{connecting ? 'Cancel' : 'Rescan'}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.card} testID="pair-confirm">
          <Text style={styles.cardTitle}>
            {scanned.payload.platform ? `${PLATFORM_GLYPH[scanned.payload.platform] ?? ''} ` : ''}
            Pair with {scanned.payload.deviceName ?? 'this laptop'}?
          </Text>
          {error ? <Text style={styles.error}>{error.message}</Text> : null}
          <View style={styles.row}>
            <Pressable
              style={[styles.primary, styles.flex]}
              onPress={() => void connect()}
              disabled={connecting || (!!error && !error.retryable)}
            >
              {connecting ? (
                <ActivityIndicator color={theme.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Connect</Text>
              )}
            </Pressable>
            <Pressable style={[styles.ghost, styles.flex]} onPress={cancelOrRescan}>
              <Text style={styles.ghostText}>{connecting ? 'Cancel' : 'Rescan'}</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => setShowDetails((v) => !v)}>
            <Text style={styles.link}>{showDetails ? 'Hide' : 'Show'} technical details</Text>
          </Pressable>
          {showDetails ? (
            <View>
              <Text style={styles.cardMeta}>room {scanned.payload.roomId.slice(0, 8)}…</Text>
              <Text style={styles.cardMeta}>{scanned.payload.apiBaseUrl}</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 14,
  },
  msg: { color: theme.ink, textAlign: 'center', fontSize: 15 },
  reticle: {
    position: 'absolute',
    alignSelf: 'center',
    top: '28%',
    width: 240,
    height: 240,
    borderColor: theme.accent,
    borderWidth: 3,
    borderRadius: 20,
  },
  hint: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    gap: 6,
  },
  hintText: { color: theme.ink },
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    backgroundColor: theme.panel,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 6,
  },
  cardTitle: { color: theme.ink, fontSize: 18, fontWeight: '700' },
  cardMeta: { color: theme.muted, fontSize: 13 },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  flex: { flex: 1 },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: theme.onAccent, fontWeight: '700', fontSize: 16 },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  ghostText: { color: theme.ink, fontWeight: '600' },
  link: { color: theme.accent, marginTop: 8, fontSize: 13 },
  error: { color: theme.danger, fontSize: 13, textAlign: 'center' },
});
