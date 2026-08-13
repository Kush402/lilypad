import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
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
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator initialRouteName="Devices">
          <Stack.Screen
            name="Devices"
            component={DeviceListScreen}
            options={{ title: 'Your laptops' }}
          />
          <Stack.Screen name="Scanner" component={ScannerScreen} options={{ title: 'Scan QR' }} />
          <Stack.Screen name="SignIn" component={SignInRoute} options={{ title: 'Sign in' }} />
          <Stack.Screen
            name="AccountDevices"
            component={AccountDevicesScreen}
            options={{ title: 'Your devices' }}
          />
          <Stack.Screen name="Viewer" component={ViewerScreen} options={{ title: 'Session' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
