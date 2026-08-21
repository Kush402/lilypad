import React from 'react';
import { Alert } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import type { AccountDevice } from '@lilypad/protocol';
import { AccountDevicesScreen } from './AccountDevicesScreen';
import {
  AccountDeleteConfirmationError,
  deleteAccount,
  listAccountDevices,
  renameAccountDevice,
  revokeAccountDevice,
} from '../lib/accountDevices';
import type { RootStackParamList } from '../types';

jest.mock('../lib/accountDevices', () => {
  class AccountDeviceError extends Error {}
  // The real subclass relationship, not a stub: the screen distinguishes a
  // mistyped address from a failure it can do nothing about, and a mock that
  // flattened them would make that distinction untestable.
  class AccountDeleteConfirmationError extends AccountDeviceError {}
  return {
    AccountDeviceError,
    AccountDeleteConfirmationError,
    listAccountDevices: jest.fn(),
    renameAccountDevice: jest.fn(),
    revokeAccountDevice: jest.fn(),
    deleteAccount: jest.fn(),
  };
});

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

  describe('deleting the account', () => {
    /**
     * The only irreversible thing in the app. A phone is also the only device
     * a user still has when their Mac is lost, so this is the recovery path as
     * well as the destruction one — which is why it exists here and not only
     * on the desktop.
     */
    beforeEach(() => {
      (listAccountDevices as jest.Mock).mockResolvedValue([device()]);
    });

    it('is not one press away', async () => {
      renderScreen();
      await screen.findByTestId('delete-account');

      expect(screen.queryByTestId('delete-account-panel')).toBeNull();
      expect(screen.queryByTestId('delete-confirm')).toBeNull();
    });

    it('says what will happen before asking for anything', async () => {
      renderScreen();
      fireEvent.press(await screen.findByTestId('delete-account'));

      expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    });

    it('sends the typed address, trimmed', async () => {
      (deleteAccount as jest.Mock).mockResolvedValue(undefined);
      renderScreen();
      fireEvent.press(await screen.findByTestId('delete-account'));
      fireEvent.changeText(screen.getByTestId('delete-confirm-email'), '  ada@example.com ');
      fireEvent.press(screen.getByTestId('delete-confirm'));

      await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(API, 'ada@example.com'));
    });

    it('does not call the API with an empty confirmation', async () => {
      renderScreen();
      fireEvent.press(await screen.findByTestId('delete-account'));
      fireEvent.press(screen.getByTestId('delete-confirm'));

      expect(deleteAccount).not.toHaveBeenCalled();
    });

    it('sends the user to sign-in once the account is gone', async () => {
      // Every screen behind this one is about data that no longer exists.
      (deleteAccount as jest.Mock).mockResolvedValue(undefined);
      renderScreen();
      fireEvent.press(await screen.findByTestId('delete-account'));
      fireEvent.changeText(screen.getByTestId('delete-confirm-email'), 'ada@example.com');
      fireEvent.press(screen.getByTestId('delete-confirm'));

      expect(await screen.findByText('sign-in-screen')).toBeTruthy();
    });

    it('keeps the form open on a mistyped address so the typo can be fixed', async () => {
      (deleteAccount as jest.Mock).mockRejectedValue(
        new AccountDeleteConfirmationError('That is not the email address on this account.'),
      );
      renderScreen();
      fireEvent.press(await screen.findByTestId('delete-account'));
      fireEvent.changeText(screen.getByTestId('delete-confirm-email'), 'wrong@example.com');
      fireEvent.press(screen.getByTestId('delete-confirm'));

      expect(await screen.findByText(/not the email address on this account/i)).toBeTruthy();
      expect(screen.getByTestId('delete-confirm')).toBeTruthy();
      expect(screen.queryByText('sign-in-screen')).toBeNull();
    });

    it('cancelling forgets what was typed', async () => {
      renderScreen();
      fireEvent.press(await screen.findByTestId('delete-account'));
      fireEvent.changeText(screen.getByTestId('delete-confirm-email'), 'ada@example.com');
      fireEvent.press(screen.getByTestId('delete-cancel'));

      expect(screen.queryByTestId('delete-account-panel')).toBeNull();
      fireEvent.press(screen.getByTestId('delete-account'));
      expect(screen.getByTestId('delete-confirm-email').props.value).toBe('');
      expect(deleteAccount).not.toHaveBeenCalled();
    });
  });
});
