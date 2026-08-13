import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountDevice } from '@lilypad/protocol';
import type { RootStackParamList } from '../types';
import { theme } from '../theme';
import {
  listAccountDevices,
  renameAccountDevice,
  revokeAccountDevice,
} from '../lib/accountDevices';
import { DeviceAuthError } from '../lib/auth';

type Props = NativeStackScreenProps<RootStackParamList, 'AccountDevices'>;

/**
 * Your devices (P2) — every machine on this account.
 *
 * **Not the same list as "Your laptops."** That one is the laptops this phone
 * has paired with, held locally; this one is what the ACCOUNT owns
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)). Forgetting
 * a laptop severs one pairing; removing a device here withdraws ownership, so
 * it loses every pairing at once and cannot authenticate at all. The copy has
 * to keep those apart, because a user who confuses them either does far less
 * than they intended or far more.
 */

const KIND_GLYPH: Record<string, string> = { desktop: '💻', mobile: '📱' };

function lastSeenLabel(device: AccountDevice): string {
  if (device.state === 'revoked') return 'removed';
  if (device.activeSession) return 'in a session now';
  if (!device.lastSeenAt) return 'never connected';
  const mins = Math.round((Date.now() - Date.parse(device.lastSeenAt)) / 60_000);
  if (mins < 1) return 'active just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `last seen ${hours}h ago`;
  return `last seen ${Math.round(hours / 24)}d ago`;
}

export function AccountDevicesScreen({ route, navigation }: Props): React.JSX.Element {
  const { apiBaseUrl } = route.params;
  const insets = useSafeAreaInsets();
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await listAccountDevices(apiBaseUrl));
      setError(null);
    } catch (err) {
      // An un-enrolled phone is sent to sign in rather than shown an empty
      // list — "you own nothing" is a different and false claim.
      if (err instanceof DeviceAuthError) {
        navigation.replace('SignIn', { apiBaseUrl });
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load your devices.');
    }
  }, [apiBaseUrl, navigation]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commitRename = useCallback(
    async (device: AccountDevice) => {
      const name = draftName.trim();
      setRenaming(null);
      if (name.length === 0 || name === device.name) return;
      setBusy(device.id);
      try {
        await renameAccountDevice(apiBaseUrl, device.id, name);
        await refresh();
      } catch (err) {
        Alert.alert('Rename failed', err instanceof Error ? err.message : 'Please try again.');
      } finally {
        setBusy(null);
      }
    },
    [apiBaseUrl, draftName, refresh],
  );

  const confirmRevoke = useCallback(
    (device: AccountDevice) => {
      const label = device.name ?? (device.kind === 'desktop' ? 'this computer' : 'this phone');
      Alert.alert(
        `Remove ${label}?`,
        device.isCurrentDevice
          ? 'This is the phone you are using. It will be signed out immediately and you will need to sign in again.'
          : 'It loses access straight away, including any session running right now. You can add it back later.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              setBusy(device.id);
              void revokeAccountDevice(apiBaseUrl, device.id)
                .then(refresh)
                .catch((err: unknown) => {
                  Alert.alert(
                    'Could not remove',
                    err instanceof Error ? err.message : 'Please try again.',
                  );
                })
                .finally(() => setBusy(null));
            },
          },
        ],
      );
    },
    [apiBaseUrl, refresh],
  );

  const padding = {
    paddingTop: Math.max(16, insets.top),
    paddingBottom: Math.max(24, insets.bottom),
    paddingLeft: Math.max(20, insets.left),
    paddingRight: Math.max(20, insets.right),
  };

  if (devices === null) {
    return (
      <View style={[styles.container, styles.center, padding]}>
        {error === null ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <>
            <Text style={styles.error}>{error}</Text>
            <Pressable style={styles.primary} onPress={() => void refresh()}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.container, padding]} testID="account-devices">
      <Text style={styles.subtitle}>
        Everything signed in to your account. Removing a device signs it out everywhere — different
        from forgetting a laptop, which only ends this phone&apos;s pairing with it.
      </Text>

      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No devices on this account yet.</Text>}
        renderItem={({ item }) => (
          <View style={[styles.card, item.state === 'revoked' && styles.cardRevoked]}>
            <View style={styles.cardInfo}>
              {renaming === item.id ? (
                <TextInput
                  testID={`rename-${item.id}`}
                  style={styles.input}
                  value={draftName}
                  onChangeText={setDraftName}
                  autoFocus
                  maxLength={120}
                  onBlur={() => void commitRename(item)}
                  onSubmitEditing={() => void commitRename(item)}
                />
              ) : (
                <Text style={styles.cardName}>
                  {KIND_GLYPH[item.kind] ?? ''} {item.name ?? `Unnamed ${item.kind}`}
                  {item.isCurrentDevice ? (
                    <Text testID="current-device" style={styles.thisDevice}>
                      {' '}
                      · this phone
                    </Text>
                  ) : null}
                </Text>
              )}
              <Text style={styles.cardMeta}>
                {item.fingerprint} · {lastSeenLabel(item)}
              </Text>
            </View>

            {item.state === 'revoked' ? (
              <Text style={styles.cardMeta}>Removed. Sign in on it again to restore access.</Text>
            ) : (
              <View style={styles.cardActions}>
                <Pressable
                  disabled={busy === item.id}
                  onPress={() => {
                    setDraftName(item.name ?? '');
                    setRenaming(item.id);
                  }}
                >
                  <Text style={styles.action}>Rename</Text>
                </Pressable>
                <Pressable disabled={busy === item.id} onPress={() => confirmRevoke(item)}>
                  <Text style={[styles.action, styles.danger]}>
                    {busy === item.id ? 'Working…' : 'Remove'}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      />

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: 14 },
  subtitle: { color: theme.muted, fontSize: 13, marginBottom: 14 },
  list: { gap: 12, paddingBottom: 16 },
  empty: { color: theme.muted, textAlign: 'center', marginTop: 40 },
  card: { backgroundColor: theme.panel, borderRadius: 14, padding: 16, gap: 10 },
  cardRevoked: { opacity: 0.55 },
  cardInfo: { gap: 3 },
  cardName: { color: theme.ink, fontSize: 16, fontWeight: '600' },
  thisDevice: { color: theme.muted, fontWeight: '400' },
  cardMeta: { color: theme.muted, fontSize: 13 },
  cardActions: { flexDirection: 'row', gap: 20 },
  action: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  danger: { color: theme.danger },
  input: {
    color: theme.ink,
    fontSize: 16,
    borderBottomColor: theme.accent,
    borderBottomWidth: 1,
    paddingVertical: 4,
  },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  primaryText: { color: theme.onAccent, fontWeight: '700', fontSize: 16 },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center' },
});
