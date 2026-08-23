import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DeviceListScreen } from './DeviceListScreen';
import { loadPairs, reconcilePairs, type PairedDesktop } from '../lib/pairs';
import { listMyPairs } from '../lib/accountDevices';
import { useSession } from '../lib/sessionContext';
import type { RootStackParamList } from '../types';

jest.mock('../lib/pairs', () => ({
  loadPairs: jest.fn(),
  forgetPair: jest.fn(),
  touchPair: jest.fn(),
  reconcilePairs: jest.fn(),
}));
jest.mock('../lib/api', () => ({ requestConnect: jest.fn(), requestUnpair: jest.fn() }));
jest.mock('../lib/accountDevices', () => ({ listMyPairs: jest.fn() }));
jest.mock('../lib/sessionContext', () => ({ useSession: jest.fn() }));

const ACCOUNT_API = 'https://api.takedia.com';
/** A laptop that advertises a different host. This is not exotic: it is what a
 * self-hoster has, what a dev tunnel produces, and what `config.ts` derives by
 * default for a backend nobody has pinned — `http://<lan-ip>:8080`. */
const LAPTOP_API = 'http://192.168.1.50:8080';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Renders whichever apiBaseUrl it was navigated with, so the assertion can be
 * about the value that actually crossed the boundary. */
function AccountDevicesStub({ route }: { route: { params?: { apiBaseUrl?: string } } }) {
  const ReactActual = jest.requireActual('react') as typeof React;
  return ReactActual.createElement(
    'Text',
    null,
    `account-devices:${route.params?.apiBaseUrl ?? 'none'}`,
  );
}

function pair(over: Partial<PairedDesktop> = {}): PairedDesktop {
  return {
    desktopDeviceId: 'desktop-1',
    name: 'Kush’s MacBook',
    apiBaseUrl: LAPTOP_API,
    connectSecret: 'secret',
    lastConnectedAt: null,
    ...over,
  } as PairedDesktop;
}

function renderScreen() {
  return render(
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Devices" component={DeviceListScreen} />
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Stack.Screen name="AccountDevices" component={AccountDevicesStub as any} />
      </Stack.Navigator>
    </NavigationContainer>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (useSession as jest.Mock).mockReturnValue({
    session: { userId: 'u1', email: 'ben@asu.edu', apiBaseUrl: ACCOUNT_API },
    signOut: jest.fn(),
  });
  (loadPairs as jest.Mock).mockResolvedValue([]);
  (listMyPairs as jest.Mock).mockRejectedValue(new Error('offline'));
  (reconcilePairs as jest.Mock).mockResolvedValue([]);
});

/**
 * "Your devices" is an ACCOUNT screen, so it has exactly one correct backend:
 * the one this phone is signed in to.
 *
 * The screen used to prefer `pairs[0].apiBaseUrl`. A paired laptop's address is
 * the right place to ring THAT laptop; it is the wrong place to ask about an
 * account. `accessToken` refuses to use this phone's device key against a
 * backend that is not its own (`assertHomeBackend`, L-29), so the account
 * screen threw and replaced itself with a sign-in form aimed at whatever host
 * the laptop had advertised.
 */
describe('which backend “Your devices” asks', () => {
  it('asks the account’s backend even when a paired laptop names another', async () => {
    (loadPairs as jest.Mock).mockResolvedValue([pair()]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('Kush’s MacBook')).toBeTruthy());

    fireEvent.press(screen.getByTestId('open-account-devices'));

    await waitFor(() => expect(screen.getByText(`account-devices:${ACCOUNT_API}`)).toBeTruthy());
    expect(screen.queryByText(`account-devices:${LAPTOP_API}`)).toBeNull();
  });

  it('asks the account’s backend with nothing paired at all', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText('No paired laptops yet')).toBeTruthy());

    fireEvent.press(screen.getByTestId('open-account-devices'));

    await waitFor(() => expect(screen.getByText(`account-devices:${ACCOUNT_API}`)).toBeTruthy());
  });
});
