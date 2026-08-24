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
import { defaultApiBaseUrl } from '../config/backend';
import type { AccountDevice } from '@lilypad/protocol';
import type { RootStackParamList } from '../types';
import { theme } from '../theme';
import {
  AccountDeleteConfirmationError,
  deleteAccount,
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
  // Optional since P3. The caller passes the account's backend (a paired
  // laptop's, or the session's); the shipped default is the answer for a phone
  // that has paired nothing yet.
  const apiBaseUrl = route.params?.apiBaseUrl ?? defaultApiBaseUrl();
  const insets = useSafeAreaInsets();
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The delete flow, collapsed until asked for. This is the only irreversible
  // thing in the app, and a button that is always on screen is a button that
  // eventually gets pressed by accident.
  const [deleting, setDeleting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const confirmDeleteAccount = useCallback(async () => {
    setBusy('account');
    setDeleteError(null);
    try {
      await deleteAccount(apiBaseUrl, confirmEmail.trim());
      // The account is gone, so every screen behind this one is about data
      // that no longer exists. Sign-in is the only honest destination.
      navigation.replace('SignIn', { apiBaseUrl });
    } catch (err) {
      // A mistyped address keeps the form open — it is a typo, not a failure
      // the user can do nothing about.
      setDeleteError(
        err instanceof AccountDeleteConfirmationError || err instanceof Error
          ? err.message
          : 'Could not delete your account.',
      );
    } finally {
      setBusy(null);
    }
  }, [apiBaseUrl, confirmEmail, navigation]);

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
            <Pressable
              style={styles.primary}
              onPress={() => void refresh()}
              accessibilityRole="button"
            >
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
                {/* The first question any support conversation asks, put where
                    the person answering it can read it out. Omitted rather
                    than guessed when the device has not reported one. */}
                {item.appVersion ? ` · v${item.appVersion}` : ''}
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
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy === item.id }}
                  // Every row's button says the same word. The device name is
                  // what tells them apart, and it is only there to look at.
                  accessibilityLabel={`Rename ${item.name ?? `unnamed ${item.kind}`}`}
                  hitSlop={{ top: 14, bottom: 14, left: 12, right: 12 }}
                >
                  <Text style={styles.action}>Rename</Text>
                </Pressable>
                <Pressable
                  disabled={busy === item.id}
                  onPress={() => confirmRevoke(item)}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy === item.id, busy: busy === item.id }}
                  // Removing the phone you are holding signs it out
                  // immediately. Sighted users get that from the "· this
                  // phone" tag beside the name; spoken, it has to be in the
                  // button itself, because the confirm sheet arrives after
                  // the tap.
                  accessibilityLabel={
                    item.isCurrentDevice
                      ? 'Remove this phone, signing it out'
                      : `Remove ${item.name ?? `unnamed ${item.kind}`}`
                  }
                  hitSlop={{ top: 14, bottom: 14, left: 12, right: 12 }}
                >
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

      {deleting ? (
        <View style={styles.deletePanel} testID="delete-account-panel">
          <Text style={styles.deleteWarning}>
            This permanently deletes your account, every device on it, and every pairing between
            them. Your Macs stay installed but stop being yours. This cannot be undone.
          </Text>
          <TextInput
            testID="delete-confirm-email"
            style={styles.input}
            placeholder="Type your account email to confirm"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={confirmEmail}
            onChangeText={setConfirmEmail}
          />
          {deleteError !== null ? <Text style={styles.error}>{deleteError}</Text> : null}
          <View style={styles.cardActions}>
            <Pressable
              testID="delete-confirm"
              disabled={busy !== null || confirmEmail.trim().length === 0}
              onPress={() => void confirmDeleteAccount()}
            >
              <Text
                style={[
                  styles.action,
                  styles.danger,
                  (busy !== null || confirmEmail.trim().length === 0) && styles.actionDisabled,
                ]}
              >
                {busy === 'account' ? 'Deleting…' : 'Permanently delete'}
              </Text>
            </Pressable>
            <Pressable
              testID="delete-cancel"
              disabled={busy !== null}
              onPress={() => {
                setDeleting(false);
                setConfirmEmail('');
                setDeleteError(null);
              }}
            >
              <Text style={styles.action}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          testID="delete-account"
          style={styles.deleteEntry}
          onPress={() => {
            setDeleting(true);
            setDeleteError(null);
          }}
        >
          <Text style={[styles.action, styles.danger]}>Delete account</Text>
        </Pressable>
      )}
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
  actionDisabled: { opacity: 0.45 },
  danger: { color: theme.danger },
  deleteEntry: { paddingVertical: 14, alignItems: 'center' },
  deletePanel: {
    gap: 12,
    paddingTop: 14,
    borderTopColor: theme.line,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  deleteWarning: { color: theme.danger, fontSize: 13, lineHeight: 18 },
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
