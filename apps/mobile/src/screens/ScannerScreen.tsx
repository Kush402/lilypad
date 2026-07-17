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
import { decodeQrPayload, type QrPayload } from '@lilypad/protocol';
import type { RootStackParamList } from '../types';
import { redeemToken } from '../lib/api';
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
 * QR scanner (react-native-vision-camera). On scan it parses the payload with
 * the shared @lilypad/protocol schema, then lets the user Connect — which
 * redeems the single-use token against the backend and moves to the viewer.
 */
export function ScannerScreen({ navigation }: Props) {
  const [permStatus, setPermStatus] = useState<CameraPermissionStatus>(() =>
    Camera.getCameraPermissionStatus(),
  );
  const device = useCameraDevice('back');
  const [scanned, setScanned] = useState<QrPayload | null>(null);
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
        setScanned(decodeQrPayload(value));
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
    if (!scanned) return;
    const myRequest = ++requestSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setConnecting(true);
    setError(null);
    try {
      const res = await redeemToken(scanned.apiBaseUrl, scanned.token, controller.signal);
      if (myRequest !== requestSeq.current) return; // superseded by Rescan/a later attempt
      navigation.replace('Viewer', {
        payload: scanned,
        roomId: res.roomId,
        signalingUrl: res.signalingUrl,
        scopes: res.scopes,
        desktopDeviceName: res.desktopDeviceName,
      });
    } catch (e) {
      if (myRequest !== requestSeq.current) return;
      setError(toAppError(e));
      setConnecting(false);
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
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {scanned.platform ? `${PLATFORM_GLYPH[scanned.platform] ?? ''} ` : ''}
            Pair with {scanned.deviceName ?? 'this laptop'}?
          </Text>
          {error ? <Text style={styles.error}>{error.message}</Text> : null}
          <View style={styles.row}>
            <Pressable
              style={[styles.primary, styles.flex]}
              onPress={() => void connect()}
              disabled={connecting || (!!error && !error.retryable)}
            >
              {connecting ? (
                <ActivityIndicator color="#06231a" />
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
              <Text style={styles.cardMeta}>room {scanned.roomId.slice(0, 8)}…</Text>
              <Text style={styles.cardMeta}>{scanned.apiBaseUrl}</Text>
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
  primaryText: { color: '#06231a', fontWeight: '700', fontSize: 16 },
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
