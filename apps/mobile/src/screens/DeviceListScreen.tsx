import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../types';
import { theme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Devices'>;

/**
 * Device list — STUB. Trusted-device persistence lands in M5. For M1 it just
 * launches the QR scanner to pair a laptop.
 */
export function DeviceListScreen({ navigation }: Props) {
  // Fixed padding was either too generous or insufficient depending on
  // device notch/home-indicator geometry. See
  // docs/audit/m3/mobile-ux.md Finding 15.
  const insets = useSafeAreaInsets();
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
      <View style={styles.empty}>
        <Text style={styles.emptyIcon}>💻</Text>
        <Text style={styles.emptyTitle}>No paired laptops yet</Text>
        <Text style={styles.emptyBody}>
          Click the Lilypad bubble on your laptop to show a QR code, then scan it here.
        </Text>
      </View>

      <Pressable style={styles.primary} onPress={() => navigation.navigate('Scanner')}>
        <Text style={styles.primaryText}>Scan a laptop's QR</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Padding itself is applied inline per-edge from useSafeAreaInsets() — see
  // Finding 15.
  container: { flex: 1, backgroundColor: theme.bg, justifyContent: 'space-between' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyIcon: { fontSize: 52 },
  emptyTitle: { color: theme.ink, fontSize: 18, fontWeight: '600' },
  emptyBody: { color: theme.muted, textAlign: 'center', paddingHorizontal: 20 },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryText: { color: '#06231a', fontWeight: '700', fontSize: 16 },
});
