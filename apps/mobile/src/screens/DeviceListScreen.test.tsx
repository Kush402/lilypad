import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DeviceListScreen } from './DeviceListScreen';
import { loadPairs, reconcilePairs, touchPair, type PairedDesktop } from '../lib/pairs';
import { requestConnectForPair } from '../lib/api';
import { listMyPairs } from '../lib/accountDevices';
import { useSession } from '../lib/sessionContext';
import type { RootStackParamList } from '../types';

jest.mock('../lib/pairs', () => ({
  loadPairs: jest.fn(),
  forgetPair: jest.fn(),
  touchPair: jest.fn(),
  reconcilePairs: jest.fn(),
  // The real one: it is a pure sort, and stubbing it would let a change to the
  // list's order pass this file unnoticed.
  orderPairs: jest.requireActual('../lib/pairs').orderPairs,
}));
jest.mock('../lib/api', () => ({ requestConnectForPair: jest.fn(), requestUnpair: jest.fn() }));
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

/** Renders the pin that actually crossed into the Viewer, so the assertion is
 * about the value the route carried rather than about a mock's arguments. */
function ViewerStub({ route }: { route: { params?: { signalingTlsPin?: string } } }) {
  const ReactActual = jest.requireActual('react') as typeof React;
  return ReactActual.createElement(
    'Text',
    null,
    `viewer-pin:${route.params?.signalingTlsPin ?? 'none'}`,
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
        <Stack.Screen name="AccountDevices" component={AccountDevicesStub as any} />
        <Stack.Screen name="Viewer" component={ViewerStub as any} />
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

  /**
   * The first thing a customer sees after signing in on a phone, and the place
   * the product is most easily read as broken.
   *
   * Signing in on a Mac puts it on the account
   * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)), so it
   * is already in "Your devices" while this screen still says "no paired
   * laptops". Two lists, two questions — but only if this one says so. An empty
   * state that reads as "you have no computers" contradicts the other screen,
   * and the customer believes the one they are looking at.
   */
  it('explains that an empty list is not an empty account', async () => {
    renderScreen();

    const body = await screen.findByText(/Signing in on a computer puts it on your account/);
    const text = body.props.children as string;
    // Names where the computers ARE…
    expect(text).toMatch(/Your devices/);
    // …and what this list is separately about.
    expect(text).toMatch(/[Pp]airing is the separate step/);
  });
});

/**
 * The reported v0.1.21 bug, at the exact line that caused it.
 *
 * Tapping a paired laptop passed `pair.lanTlsCertSha256` into the Viewer no
 * matter which target the ring had actually resolved to. When the laptop and
 * the phone landed on different subnets the LAN probe failed,
 * `requestConnectForPair` correctly fell back to cloud — and the phone opened a
 * socket to `api.takedia.com` pinned to the Mac's self-signed certificate. That
 * handshake can never complete: six rings, all HTTP 200, the desktop seated in
 * all six rooms, and not one WebSocket upgrade from the phone's IP.
 */
describe('which TLS pin a ring hands the Viewer', () => {
  beforeEach(() => {
    // Fire-and-forget in the screen, but it is `.catch()`ed there — an
    // undefined return throws before the navigate ever runs.
    (touchPair as jest.Mock).mockResolvedValue(undefined);
  });

  it('sends none when the ring fell back to cloud, even though the pair has one', async () => {
    (loadPairs as jest.Mock).mockResolvedValue([pair({ lanTlsCertSha256: 'a'.repeat(64) })]);
    (requestConnectForPair as jest.Mock).mockResolvedValue({
      roomId: 'room-1',
      signalingUrl: 'wss://api.takedia.com/ws/signal',
      scopes: ['view'],
      desktopDeviceName: 'Kush’s MacBook',
    });
    renderScreen();
    fireEvent.press(await screen.findByText('Connect'));

    expect(await screen.findByText('viewer-pin:none')).toBeTruthy();
  });

  it('sends the one the ring returned when LAN won', async () => {
    (loadPairs as jest.Mock).mockResolvedValue([pair({ lanTlsCertSha256: 'a'.repeat(64) })]);
    (requestConnectForPair as jest.Mock).mockResolvedValue({
      roomId: 'room-1',
      signalingUrl: 'wss://192.168.1.50:8787/ws/signal',
      scopes: ['view'],
      desktopDeviceName: 'Kush’s MacBook',
      signalingTlsPin: 'b'.repeat(64),
    });
    renderScreen();
    fireEvent.press(await screen.findByText('Connect'));

    expect(await screen.findByText(`viewer-pin:${'b'.repeat(64)}`)).toBeTruthy();
  });
});
