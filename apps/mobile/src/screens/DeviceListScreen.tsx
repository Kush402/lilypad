import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, FlatList, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../types';
import { theme } from '../theme';
import {
  loadPairs,
  forgetPair,
  touchPair,
  orderPairs,
  reconcilePairs,
  type PairedDesktop,
} from '../lib/pairs';
import { requestConnectForPair, requestUnpair } from '../lib/api';
import { toAppError } from '../lib/errors';
import { useSession } from '../lib/sessionContext';
import { listMyPairs } from '../lib/accountDevices';
import { clearResumeHandle, loadResumeHandle } from '../lib/sessionResume';
import { LaptopGlyph } from '../components/Glyph';

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
  const resumeAttempted = useRef(false);
  const { session, signOut } = useSession();
  /**
   * Which backend "Your devices" asks.
   *
   * The session's, always. This screen only exists when there IS a session
   * (`App.tsx` swaps the whole stack), and an account's devices live on the
   * account's server — nowhere else.
   *
   * It used to prefer `pairs[0].apiBaseUrl`, on the reasoning that a paired
   * laptop's address is the one that laptop lives on. True, and it is the right
   * address to RING that laptop at; it is the wrong one to ask about an
   * account. The moment a paired laptop advertised a different host — a
   * self-hoster, a dev tunnel, or a desktop on a LAN address, which is what
   * `config.ts` derives by default — tapping "Your devices" reached a server
   * this phone has no session on. `accessToken` refuses to use a device key
   * against a backend that is not its own (`assertHomeBackend`, L-29), so the
   * screen threw and bounced the user to a sign-in form pointed at a stranger's
   * server. Nothing leaked; the account screen was simply unreachable.
   */
  const accountApiBaseUrl = session?.apiBaseUrl;

  const refresh = useCallback(() => {
    void loadPairs().then((p) => setPairs(orderPairs(p)));
  }, []);

  // Cold start while the Mac is still Active: rejoin that room. Explicit
  // Connect below is a Ring and still supersedes.
  useEffect(() => {
    if (resumeAttempted.current) return;
    resumeAttempted.current = true;
    void (async () => {
      const handle = await loadResumeHandle();
      if (!handle) return;
      const local = await loadPairs();
      const pair = local.find((p) => p.desktopDeviceId === handle.desktopDeviceId);
      if (!pair?.connectSecret) {
        await clearResumeHandle();
        return;
      }
      setConnecting(pair.desktopDeviceId);
      try {
        const res = await requestConnectForPair(pair, { resume: true });
        if (!res.resumed) {
          await clearResumeHandle();
          return;
        }
        void touchPair(pair.desktopDeviceId).catch(() => {});
        navigation.navigate('Viewer', {
          roomId: res.roomId,
          signalingUrl: res.signalingUrl,
          scopes: res.scopes,
          desktopDeviceName: res.desktopDeviceName ?? pair.name,
          desktopDeviceId: pair.desktopDeviceId,
          signalingTlsPin: res.signalingTlsPin,
          rejoin: true,
        });
      } catch (e) {
        if (toAppError(e).code === 'session_gone') await clearResumeHandle();
      } finally {
        setConnecting(null);
      }
    })();
  }, [navigation]);

  /**
   * Ask the backend which of these laptops still exist, and drop the ones that
   * do not.
   *
   * The local list is the keychain's, and until now it was checked against
   * nothing: a laptop revoked from the other side, or on a deleted account,
   * kept sitting here until the user tapped it and the connect failed with
   * `not_trusted`. That is the wrong place to learn it.
   *
   * **Every failure is swallowed on purpose.** This function DELETES rows, so
   * the only safe reading of "the request did not succeed" is "I know
   * nothing", never "you have no laptops". Offline, a lapsed token, a moved
   * backend and a 500 all leave the list exactly as it was; the user still
   * sees their laptops and Connect still gives them the specific error it
   * always did.
   *
   * Reconciliation runs per backend, because a phone may hold pairs on several
   * — that is what makes self-hosting work — and each one can only speak for
   * its own.
   */
  const reconcile = useCallback(async () => {
    const local = await loadPairs();
    const bases = [...new Set(local.map((p) => p.apiBaseUrl))];
    for (const base of bases) {
      try {
        const remote = await listMyPairs(base);
        setPairs(orderPairs(await reconcilePairs(remote, base)));
      } catch {
        /* see above: never prune on an answer we did not get */
      }
    }
  }, []);

  // Refresh on focus: the scanner adds pairs behind this screen's back.
  // The local read paints immediately; reconciliation follows and can only
  // remove rows the backend says are gone.
  useEffect(() => {
    const onFocus = () => {
      refresh();
      void reconcile();
    };
    onFocus();
    return navigation.addListener('focus', onFocus);
  }, [navigation, refresh, reconcile]);

  const connect = useCallback(
    async (pair: PairedDesktop) => {
      setConnecting(pair.desktopDeviceId);
      try {
        const res = await requestConnectForPair(pair);
        void touchPair(pair.desktopDeviceId).catch(() => {});
        navigation.navigate('Viewer', {
          roomId: res.roomId,
          signalingUrl: res.signalingUrl,
          scopes: res.scopes,
          desktopDeviceName: res.desktopDeviceName ?? pair.name,
          desktopDeviceId: pair.desktopDeviceId,
          // `res.signalingTlsPin`, never `pair.lanTlsCertSha256`. The pair's
          // pin is for the laptop's LAN endpoint; `res.signalingUrl` is only
          // that endpoint when the LAN probe won, and passing the pin anyway
          // is what pinned a cloud socket to a self-signed LAN certificate and
          // hung every ring on v0.1.21.
          signalingTlsPin: res.signalingTlsPin,
        });
      } catch (e) {
        const err = toAppError(e);
        // A dead/changed backend address (an ephemeral dev tunnel that
        // rotated, a moved deployment) surfaces as server/network errors
        // against the STORED apiBaseUrl — tell the user the one action that
        // actually fixes it, not just "try again".
        const message =
          err.code === 'server_error' || err.code === 'network_unreachable'
            ? `${err.message}\n\nIf this keeps happening, the laptop's server address may have changed. Scan its QR code once to refresh it.`
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
        `Unpair ${pair.name ?? 'this laptop'}?`,
        'It disappears from this list. You can pair again anytime by scanning its QR code.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Unpair',
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

  const confirmSignOut = useCallback(() => {
    Alert.alert(
      'Sign out?',
      'Your pairings end, on this phone and on the laptops. This phone stays on your account until you remove it from "Your devices", and you can pair again by scanning each laptop’s code.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
      ],
    );
  }, [signOut]);

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
          <View style={styles.emptyIcon}>
            <LaptopGlyph size={34} />
          </View>
          <Text style={styles.emptyTitle}>No paired laptops yet</Text>
          {/* The distinction a first-time customer trips on. Signing in on a
              Mac puts it on the account, so it is already in "Your devices" —
              and a list here that says "no laptops" while that one says
              otherwise reads as a bug rather than as two different questions.
              Say which is which before they go looking. */}
          <Text style={styles.emptyBody}>
            Signing in on a computer puts it on your account, and you can see them under Your
            devices. Pairing is the separate step that lets THIS phone see one. On the laptop: click
            the Lilypad bubble to show a QR code, then scan it here. Once per laptop.
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
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: connecting !== null,
                    busy: connecting === item.desktopDeviceId,
                  }}
                  // In a list, "Connect" spoken on its own is the same words on
                  // every row. The laptop's name is what makes the button
                  // identifiable, and it is only on screen visually.
                  accessibilityLabel={
                    connecting === item.desktopDeviceId
                      ? `Ringing ${item.name ?? 'laptop'}`
                      : `Connect to ${item.name ?? 'laptop'}`
                  }
                >
                  <Text style={styles.connectText}>
                    {connecting === item.desktopDeviceId ? 'Ringing…' : 'Connect'}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.forget}
                  onPress={() => confirmForget(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Unpair ${item.name ?? 'laptop'}`}
                  accessibilityHint="Ends this phone's pairing with that computer"
                  hitSlop={{ top: 14, bottom: 14, left: 12, right: 12 }}
                >
                  <Text style={styles.forgetText}>Unpair</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}

      <View style={styles.footer}>
        {/* Always offered now (P3). This used to appear only once a laptop was
            paired, because the app shipped no backend address and had to
            borrow one from a scanned code. The phone is signed in before it
            ever reaches this screen, so the account's own backend is known. */}
        <Pressable
          style={styles.secondary}
          testID="open-account-devices"
          onPress={() => navigation.navigate('AccountDevices', { apiBaseUrl: accountApiBaseUrl })}
          accessibilityRole="button"
          accessibilityLabel="Your devices"
          accessibilityHint="Every computer and phone on your account"
        >
          <Text style={styles.secondaryText}>Your devices</Text>
        </Pressable>
        <Pressable
          style={styles.primary}
          onPress={() => navigation.navigate('Scanner')}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>
            {pairs.length === 0 ? "Scan a laptop's QR" : 'Add another laptop'}
          </Text>
        </Pressable>

        {/* Signing out ends this phone's pairings on both sides; the device
            itself stays on the account until it is revoked from "Your
            devices". Confirmed because the pairings go with it. */}
        <Pressable
          style={styles.signOut}
          testID="sign-out"
          onPress={confirmSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutText}>
            {session?.email ? `Sign out (${session.email})` : 'Sign out'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg, justifyContent: 'space-between' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyIcon: { marginBottom: 4, opacity: 0.7 },
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
  connectText: { color: theme.onAccent, fontWeight: '700', fontSize: 15 },
  forget: { paddingVertical: 10, paddingHorizontal: 6 },
  forgetText: { color: theme.muted, fontSize: 14 },
  footer: { gap: 10 },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryText: { color: theme.onAccent, fontWeight: '700', fontSize: 16 },
  secondary: {
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryText: { color: theme.ink, fontWeight: '600', fontSize: 15 },
  signOut: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  signOutText: { color: theme.muted, fontSize: 14 },
});
