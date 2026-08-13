import React from 'react';
import { Alert } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import type { AccountDevice } from '@lilypad/protocol';
import { AccountDevicesScreen } from './AccountDevicesScreen';
import {
  listAccountDevices,
  renameAccountDevice,
  revokeAccountDevice,
} from '../lib/accountDevices';
import type { RootStackParamList } from '../types';

jest.mock('../lib/accountDevices', () => ({
  listAccountDevices: jest.fn(),
  renameAccountDevice: jest.fn(),
  revokeAccountDevice: jest.fn(),
}));

jest.mock('../lib/auth', () => {
  class DeviceAuthError extends Error {
    constructor() {
      super('This phone is not signed in yet.');
      this.name = 'DeviceAuthError';
    }
  }
  return { DeviceAuthError };
});

const { DeviceAuthError } = jest.requireMock('../lib/auth') as {
  DeviceAuthError: new () => Error;
};

const API = 'http://192.168.1.50:4000';
const Stack = createNativeStackNavigator<RootStackParamList>();

function SignInStub() {
  const ReactActual = jest.requireActual('react');
  return ReactActual.createElement('Text', null, 'sign-in-screen');
}

function device(over: Partial<AccountDevice> = {}): AccountDevice {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'mobile',
    platform: 'ios',
    name: 'ios phone',
    fingerprint: '…123456',
    state: 'linked',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    activeSession: false,
    isCurrentDevice: false,
    ...over,
  };
}

function renderScreen() {
  return render(
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName="AccountDevices">
        <Stack.Screen
          name="AccountDevices"
          component={AccountDevicesScreen}
          initialParams={{ apiBaseUrl: API }}
        />
        <Stack.Screen name="SignIn" component={SignInStub} />
      </Stack.Navigator>
    </NavigationContainer>,
  );
}

/** Take the confirm button out of the most recent Alert and press it. */
function confirmAlert(label: string) {
  const spy = Alert.alert as unknown as jest.Mock;
  const buttons = spy.mock.calls[spy.mock.calls.length - 1][2] as Array<{
    text: string;
    onPress?: () => void;
  }>;
  buttons.find((b) => b.text === label)?.onPress?.();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

describe('AccountDevicesScreen', () => {
  it('lists the account devices with their state', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([
      device({ name: 'Work MacBook', kind: 'desktop', platform: 'macos' }),
      device({ id: '22222222-2222-4222-8222-222222222222', name: 'ios phone' }),
    ]);

    renderScreen();

    expect(await screen.findByText(/Work MacBook/)).toBeTruthy();
    expect(screen.getByText(/ios phone/)).toBeTruthy();
  });

  // The whole point of the indicator: it must come from a live session, and a
  // reachable-but-idle laptop is not one.
  it('says when a device is in a session right now', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device({ activeSession: true })]);

    renderScreen();

    expect(await screen.findByText(/in a session now/)).toBeTruthy();
  });

  it('labels the phone making the request, so it can be told apart', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device({ isCurrentDevice: true })]);

    renderScreen();

    expect(await screen.findByTestId('current-device')).toBeTruthy();
  });

  // An empty list would claim "you own nothing", which is a different and
  // false statement from "we do not know who you are".
  it('sends an un-enrolled phone to sign in rather than showing an empty list', async () => {
    (listAccountDevices as jest.Mock).mockRejectedValue(new DeviceAuthError());

    renderScreen();

    await waitFor(() => expect(screen.getByText('sign-in-screen')).toBeTruthy());
  });

  it('offers a retry instead of an empty list when the backend is unreachable', async () => {
    (listAccountDevices as jest.Mock).mockRejectedValue(new Error('Could not reach Lilypad.'));

    renderScreen();

    expect(await screen.findByText(/Could not reach Lilypad/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('renames a device and reloads the list', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device({ name: 'ios phone' })]);
    (renameAccountDevice as jest.Mock).mockResolvedValue(undefined);

    renderScreen();
    fireEvent.press(await screen.findByText('Rename'));
    fireEvent.changeText(
      screen.getByTestId('rename-11111111-1111-4111-8111-111111111111'),
      'Work phone',
    );
    fireEvent(screen.getByTestId('rename-11111111-1111-4111-8111-111111111111'), 'submitEditing');

    await waitFor(() =>
      expect(renameAccountDevice).toHaveBeenCalledWith(
        API,
        '11111111-1111-4111-8111-111111111111',
        'Work phone',
      ),
    );
  });

  it('does not call the backend for an unchanged or blank name', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device({ name: 'ios phone' })]);

    renderScreen();
    fireEvent.press(await screen.findByText('Rename'));
    fireEvent(screen.getByTestId('rename-11111111-1111-4111-8111-111111111111'), 'submitEditing');

    expect(renameAccountDevice).not.toHaveBeenCalled();
  });

  // Removing is destructive and stronger than "Forget" — it must be confirmed,
  // never done on the first tap.
  it('confirms before revoking, and does nothing if the user cancels', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device()]);

    renderScreen();
    fireEvent.press(await screen.findByText('Remove'));

    expect(Alert.alert).toHaveBeenCalled();
    expect(revokeAccountDevice).not.toHaveBeenCalled();

    confirmAlert('Cancel');
    expect(revokeAccountDevice).not.toHaveBeenCalled();
  });

  it('revokes once confirmed', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device()]);
    (revokeAccountDevice as jest.Mock).mockResolvedValue(undefined);

    renderScreen();
    fireEvent.press(await screen.findByText('Remove'));
    confirmAlert('Remove');

    await waitFor(() =>
      expect(revokeAccountDevice).toHaveBeenCalledWith(API, '11111111-1111-4111-8111-111111111111'),
    );
  });

  // Revoking the phone in your hand signs you out. That is legitimate, but the
  // consequence has to be stated before it happens, not discovered after.
  it('warns differently when removing the phone being used', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device({ isCurrentDevice: true })]);

    renderScreen();
    fireEvent.press(await screen.findByText('Remove'));

    const spy = Alert.alert as unknown as jest.Mock;
    expect(spy.mock.calls[spy.mock.calls.length - 1][1]).toMatch(/signed out immediately/);
  });

  // A revoked device stays visible so the user can see what happened and that
  // it is recoverable — but offers no actions, because there is nothing left
  // to take away.
  it('shows a removed device as removed, with no actions', async () => {
    (listAccountDevices as jest.Mock).mockResolvedValue([device({ state: 'revoked' })]);

    renderScreen();

    expect(await screen.findByText(/Removed\./)).toBeTruthy();
    expect(screen.queryByText('Remove')).toBeNull();
    expect(screen.queryByText('Rename')).toBeNull();
  });
});
