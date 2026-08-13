import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, FlatList, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../types';
import { theme } from '../theme';
import { loadPairs, forgetPair, touchPair, type PairedDesktop } from '../lib/pairs';
import { requestConnect, requestUnpair } from '../lib/api';
import { toAppError } from '../lib/errors';

type Props = NativeStackScreenProps<RootStackParamList, 'Devices'>;

function lastConnectedLabel(pair: PairedDesktop): string {
  if (!pair.lastConnectedAt) return 'paired, not yet reconnected';
  const mins = Math.round((Date.now() - pair.lastConnectedAt) / 60_000);
  if (mins < 1) return 'connected just now';
  if (mins < 60) return `last connected ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `last connected ${hours}h ago`;
  return `last connected ${Math.round(hours / 24)}d ago`;
}

/**
 * My Devices (M5.4) — paired desktops this phone can ring without a QR.
 * Connect calls `POST /connect/request`; on success the navigation params
 * mirror the scanner flow exactly, so the Viewer is none the wiser. The QR
 * scanner remains as "add a laptop" (and the recovery path for
 * not-trusted/revoked pairs).
 */
export function DeviceListScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [pairs, setPairs] = useState<PairedDesktop[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  // Any paired laptop's address will do: they are all this account's Lilypad.
  const accountApiBaseUrl = pairs[0]?.apiBaseUrl ?? null;

  const refresh = useCallback(() => {
    void loadPairs().then(setPairs);
  }, []);

  // Refresh on focus: the scanner adds pairs behind this screen's back.
  useEffect(() => {
    refresh();
    return navigation.addListener('focus', refresh);
  }, [navigation, refresh]);

  const connect = useCallback(
    async (pair: PairedDesktop) => {
      setConnecting(pair.desktopDeviceId);
      try {
        const res = await requestConnect(pair.apiBaseUrl, pair.desktopDeviceId, pair.connectSecret);
        void touchPair(pair.desktopDeviceId).catch(() => {});
        navigation.navigate('Viewer', {
          roomId: res.roomId,
          signalingUrl: res.signalingUrl,
          scopes: res.scopes,
          desktopDeviceName: res.desktopDeviceName ?? pair.name,
          desktopDeviceId: pair.desktopDeviceId,
        });
      } catch (e) {
        const err = toAppError(e);
        // A dead/changed backend address (an ephemeral dev tunnel that
        // rotated, a moved deployment) surfaces as server/network errors
        // against the STORED apiBaseUrl — tell the user the one action that
        // actually fixes it, not just "try again".
        const message =
          err.code === 'server_error' || err.code === 'network_unreachable'
            ? `${err.message}\n\nIf this keeps happening, the laptop's server address may have changed — scan its QR code once to refresh it.`
            : err.message;
        Alert.alert(pair.name ?? 'Laptop', message);
      } finally {
        setConnecting(null);
      }
    },
    [navigation],
  );

  const confirmForget = useCallback(
    (pair: PairedDesktop) => {
      Alert.alert(
        `Forget ${pair.name ?? 'this laptop'}?`,
        'It disappears from this list. You can pair again anytime by scanning its QR code.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Forget',
            style: 'destructive',
            onPress: () => {
              // Best-effort: also sever the pairing on the backend so it leaves the
              // laptop's Trusted Devices — fire-and-forget, never blocks the local
              // removal (which must succeed even offline). See `requestUnpair`.
              void requestUnpair(pair.apiBaseUrl, pair.desktopDeviceId);
              void forgetPair(pair.desktopDeviceId).then(refresh);
            },
          },
        ],
      );
    },
    [refresh],
  );

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: Math.max(24, insets.top),
          paddingBottom: Math.max(24, insets.bottom),
          paddingLeft: Math.max(24, insets.left),
          paddingRight: Math.max(24, insets.right),
        },
      ]}
    >
      {pairs.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>💻</Text>
          <Text style={styles.emptyTitle}>No paired laptops yet</Text>
          <Text style={styles.emptyBody}>
            Click the Lilypad bubble on your laptop to show a QR code, then scan it here. You only
            do this once per laptop.
          </Text>
        </View>
      ) : (
        <FlatList
          data={pairs}
          keyExtractor={(p) => p.desktopDeviceId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardInfo}>
                <Text style={styles.cardName}>{item.name ?? 'Laptop'}</Text>
                <Text style={styles.cardMeta}>{lastConnectedLabel(item)}</Text>
              </View>
              <View style={styles.cardActions}>
                <Pressable
                  style={[styles.connect, connecting === item.desktopDeviceId && styles.busy]}
                  disabled={connecting !== null}
                  onPress={() => void connect(item)}
                >
                  <Text style={styles.connectText}>
                    {connecting === item.desktopDeviceId ? 'Ringing…' : 'Connect'}
                  </Text>
                </Pressable>
                <Pressable style={styles.forget} onPress={() => confirmForget(item)}>
                  <Text style={styles.forgetText}>Forget</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}

      <View style={styles.footer}>
        {/* Account management needs a backend address and the app ships no
            default — every one it knows came from a scanned code. So this
            appears once there is a pair to take one from, rather than as a
            button that cannot work. */}
        {accountApiBaseUrl !== null ? (
          <Pressable
            style={styles.secondary}
            testID="open-account-devices"
            onPress={() => navigation.navigate('AccountDevices', { apiBaseUrl: accountApiBaseUrl })}
          >
            <Text style={styles.secondaryText}>Your devices</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.primary} onPress={() => navigation.navigate('Scanner')}>
          <Text style={styles.primaryText}>
            {pairs.length === 0 ? "Scan a laptop's QR" : 'Add another laptop'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg, justifyContent: 'space-between' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyIcon: { fontSize: 52 },
  emptyTitle: { color: theme.ink, fontSize: 18, fontWeight: '600' },
  emptyBody: { color: theme.muted, textAlign: 'center', paddingHorizontal: 20 },
  list: { gap: 12, paddingBottom: 16 },
  card: {
    backgroundColor: theme.panel,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  cardInfo: { gap: 2 },
  cardName: { color: theme.ink, fontSize: 17, fontWeight: '600' },
  cardMeta: { color: theme.muted, fontSize: 13 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  connect: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  busy: { opacity: 0.6 },
  connectText: { color: '#06231a', fontWeight: '700', fontSize: 15 },
  forget: { paddingVertical: 10, paddingHorizontal: 6 },
  forgetText: { color: theme.muted, fontSize: 14 },
  footer: { gap: 10 },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryText: { color: '#06231a', fontWeight: '700', fontSize: 16 },
  secondary: {
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryText: { color: theme.ink, fontWeight: '600', fontSize: 15 },
});
