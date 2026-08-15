import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { RootStackParamList } from './src/types';
import { theme } from './src/theme';
import { DeviceListScreen } from './src/screens/DeviceListScreen';
import { ScannerScreen } from './src/screens/ScannerScreen';
import { SignInRoute } from './src/screens/SignInRoute';
import { AccountDevicesScreen } from './src/screens/AccountDevicesScreen';
import { ViewerScreen } from './src/screens/ViewerScreen';
import { initDeviceIdentity } from './src/lib/device';
import { SessionProvider, useSession } from './src/lib/sessionContext';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.panel,
    text: theme.ink,
    primary: theme.accent,
    border: theme.line,
  },
};

/**
 * The authentication gate (P3).
 *
 * Signed out, `SignIn` is the ONLY route in the stack — not the initial route
 * of a stack that also contains the others, which would leave every account and
 * device screen one `navigate` call away from an unauthenticated phone. React
 * Navigation's own guidance is exactly this: express the guard by which screens
 * exist, so there is no protected route to reach by mistake.
 *
 * That also fixes the reachability the old ordering had backwards. Sign-in used
 * to be pushed by the SCANNER, on failure, which meant the pairing QR was the
 * app's front door and an account was something you discovered by hitting an
 * error. Now: sign in, then the laptops.
 *
 * `undefined` is the still-loading state and renders a spinner. Rendering the
 * sign-in screen while the first Keychain read is in flight would flash it at
 * every already-signed-in user on every cold start.
 */
function Routes(): React.JSX.Element {
  const { session } = useSession();

  if (session === undefined) {
    return (
      <View style={styles.loading} testID="session-loading">
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <Stack.Navigator initialRouteName={session ? 'Devices' : 'SignInGate'}>
      {session === null ? (
        // `SignInGate`, not `SignIn` — see `RootStackParamList.SignInGate`. The
        // signed-in stack keeps its own `SignIn`, and a name shared across the
        // swap is a route that survives it, which means signing in changes
        // nothing on screen.
        <Stack.Screen
          name="SignInGate"
          component={SignInRoute}
          options={{ title: 'Sign in', headerShown: false }}
        />
      ) : (
        <>
          <Stack.Screen
            name="Devices"
            component={DeviceListScreen}
            options={{ title: 'Your laptops' }}
          />
          <Stack.Screen name="Scanner" component={ScannerScreen} options={{ title: 'Scan QR' }} />
          {/* Still reachable while signed in: a scanned code can name a
              DIFFERENT backend, and the phone must be able to sign in there. */}
          <Stack.Screen name="SignIn" component={SignInRoute} options={{ title: 'Sign in' }} />
          <Stack.Screen
            name="AccountDevices"
            component={AccountDevicesScreen}
            options={{ title: 'Your devices' }}
          />
          <Stack.Screen name="Viewer" component={ViewerScreen} options={{ title: 'Session' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  // Warm the keychain-backed device identity before any pairing/redeem can
  // need it (redeemToken also awaits it — this just hides the latency).
  // Fire-and-forget: failures degrade to the old per-launch id, never crash.
  useEffect(() => {
    void initDeviceIdentity();
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <SessionProvider>
        <NavigationContainer theme={navTheme}>
          <Routes />
        </NavigationContainer>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
});
