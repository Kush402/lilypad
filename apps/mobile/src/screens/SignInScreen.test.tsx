import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SignInScreen } from './SignInScreen';
import { signInWithPassword } from '../lib/signIn';
import { resetDeviceIdentity } from '../lib/auth';

/**
 * The dead end, and the way out of it.
 *
 * A phone whose key already names a device on another account cannot enroll —
 * correctly, because a device row that changed hands would carry the previous
 * owner's pairings with it. The key survives deleting the app, so this is
 * permanent unless the screen offers a new identity. It must offer it for THAT
 * failure and no other: a new key would meet an unreachable server just the
 * same, and the offer would cost an identity for nothing.
 */

jest.mock('../lib/signIn', () => {
  class SignInError extends Error {
    // A plain field, not a parameter property: jest's mock-factory guard
    // rejects the shorthand ("Invalid variable access").
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    SignInError,
    signInWithPassword: jest.fn(),
    signUpWithPassword: jest.fn(),
    signInWithGoogle: jest.fn(),
    signInWithApple: jest.fn(),
    fetchAuthMethods: jest.fn(() => Promise.resolve(null)),
    requestMagicLink: jest.fn(),
    verifyMagicLink: jest.fn(),
    requestPasswordReset: jest.fn(),
    confirmPasswordReset: jest.fn(),
  };
});

jest.mock('../lib/auth', () => {
  class DeviceTakenError extends Error {
    constructor() {
      super(
        'This phone is already set up with a different Lilypad account. ' +
          'Sign in with that account, or start over on this phone as a new device.',
      );
      this.name = 'DeviceTakenError';
    }
  }
  return { DeviceTakenError, resetDeviceIdentity: jest.fn(() => Promise.resolve()) };
});

jest.mock('../config/oauth', () => ({ isGoogleConfigured: () => false, APPLE_BUNDLE_ID: 'x' }));
jest.mock('../config/backend', () => ({
  defaultApiBaseUrl: () => 'https://api.takedia.example',
}));

const signIn = signInWithPassword as jest.Mock;
const authMethods = jest.requireMock('../lib/signIn').fetchAuthMethods as jest.Mock;
const resetIdentity = resetDeviceIdentity as jest.Mock;
const { DeviceTakenError } = jest.requireMock('../lib/auth');

/** Fill the password form and submit it. */
function submit() {
  fireEvent.changeText(screen.getByTestId('sign-in-email'), 'ben@asu.edu');
  fireEvent.changeText(screen.getByTestId('sign-in-password'), 'a-long-password');
  fireEvent.press(screen.getByTestId('sign-in-password-submit'));
}

/** Take a button out of the most recent Alert and press it. */
function confirmAlert(label: string) {
  const spy = Alert.alert as unknown as jest.Mock;
  const buttons = spy.mock.calls[spy.mock.calls.length - 1]![2] as {
    text: string;
    onPress?: () => void;
  }[];
  const button = buttons.find((b) => b.text === label);
  if (!button) throw new Error(`no "${label}" button in the alert`);
  button.onPress?.();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

describe('a phone already set up on another account', () => {
  it('offers a way out instead of only an error', async () => {
    signIn.mockRejectedValue(new DeviceTakenError());
    render(<SignInScreen apiBaseUrl="https://api.takedia.example" onSignedIn={jest.fn()} />);

    submit();

    expect(await screen.findByTestId('sign-in-error')).toBeTruthy();
    expect(screen.getByTestId('start-over-as-new-device')).toBeTruthy();
  });

  it('does not offer it for a failure a new identity cannot fix', async () => {
    signIn.mockRejectedValue(new Error('Network request failed'));
    render(<SignInScreen apiBaseUrl="https://api.takedia.example" onSignedIn={jest.fn()} />);

    submit();

    expect(await screen.findByTestId('sign-in-error')).toBeTruthy();
    expect(screen.queryByTestId('start-over-as-new-device')).toBeNull();
  });

  it('asks before throwing the identity away, and does nothing if declined', async () => {
    signIn.mockRejectedValue(new DeviceTakenError());
    render(<SignInScreen apiBaseUrl="https://api.takedia.example" onSignedIn={jest.fn()} />);
    submit();
    fireEvent.press(await screen.findByTestId('start-over-as-new-device'));

    expect(Alert.alert).toHaveBeenCalled();
    confirmAlert('Cancel');
    expect(resetIdentity).not.toHaveBeenCalled();
  });

  it('resets the identity and finishes the sign-in the user already asked for', async () => {
    const onSignedIn = jest.fn();
    signIn.mockRejectedValueOnce(new DeviceTakenError());
    signIn.mockResolvedValueOnce({ deviceId: 'new-device', accessToken: 't' });
    render(<SignInScreen apiBaseUrl="https://api.takedia.example" onSignedIn={onSignedIn} />);
    submit();
    fireEvent.press(await screen.findByTestId('start-over-as-new-device'));

    confirmAlert('Set up as new');

    // Retried on its own, with the same credentials — not a form the user has
    // to fill in a second time and wonder whether anything happened.
    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({
        deviceId: 'new-device',
        accessToken: 't',
      }),
    );
    expect(resetIdentity).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('start-over-as-new-device')).toBeNull();
  });
});

describe('which server this account will live on', () => {
  it("says nothing when it is Lilypad's own", () => {
    render(<SignInScreen apiBaseUrl="https://api.takedia.example" onSignedIn={jest.fn()} />);
    expect(screen.queryByTestId('foreign-backend-notice')).toBeNull();
  });

  it('names the host when a scanned code sent us somewhere else', () => {
    // The address on this screen comes from a QR whenever the scanner pushed
    // it, and a code can name any host at all. Someone about to type a
    // password deserves to know where it is going first.
    render(<SignInScreen apiBaseUrl="https://not-lilypad.example" onSignedIn={jest.fn()} />);
    expect(screen.getByTestId('foreign-backend-notice')).toBeTruthy();
    expect(screen.getByText(/not-lilypad\.example/)).toBeTruthy();
  });

  it('falls back to the default when no address was passed', () => {
    render(<SignInScreen apiBaseUrl={undefined} onSignedIn={jest.fn()} />);
    expect(screen.queryByTestId('foreign-backend-notice')).toBeNull();
  });
});

/**
 * Sign-in ways that cannot work are not offered.
 *
 * Production has never had a mail sender, so `POST /auth/magic-link/request`
 * and both password-reset routes have answered 503 to every call ever made —
 * while "Email me a sign-in link instead" and "Forgot your password?" sat on
 * the first screen of the app. `GET /auth/methods` reports what the server can
 * really do, and this screen believes it.
 */
describe('offering only the ways in that work', () => {
  beforeEach(() => authMethods.mockResolvedValue(null));

  it('hides the email flows when the server says it cannot send mail', async () => {
    authMethods.mockResolvedValue({ email: false, apple: true, google: false });
    render(<SignInScreen onSignedIn={jest.fn()} />);
    await waitFor(() => expect(screen.queryByTestId('go-reset')).toBeNull());
    expect(screen.queryByTestId('go-magic-link')).toBeNull();
    // The way in that never depended on mail is untouched.
    expect(screen.getByTestId('sign-in-password-submit')).toBeTruthy();
    // And somebody who HAS forgotten their password is not left with nowhere
    // to go — hiding a dead link must not mean hiding the remedy.
    expect(screen.getByTestId('support-address')).toBeTruthy();
  });

  it('shows them the moment a mail sender exists', async () => {
    authMethods.mockResolvedValue({ email: true, apple: true, google: false });
    render(<SignInScreen onSignedIn={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('go-reset')).toBeTruthy());
    expect(screen.getByTestId('go-magic-link')).toBeTruthy();
    // No apology for a gap that is not there.
    expect(screen.queryByTestId('support-address')).toBeNull();
  });

  it('shows everything when the server cannot be reached', async () => {
    // Fails OPEN. A timeout removing the user's only way in would be a worse
    // bug than the one this whole mechanism fixes.
    authMethods.mockResolvedValue(null);
    render(<SignInScreen onSignedIn={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('go-reset')).toBeTruthy());
    expect(screen.getByTestId('go-magic-link')).toBeTruthy();
  });
});
