import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor, act } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';

/**
 * The authentication gate, through a REAL navigator.
 *
 * This file exists because of a bug that every unit test in the repo passed
 * straight through. Sign-in worked end to end — the backend logged
 * `POST /auth/password` 200 followed by `POST /devices/enroll` 200, six times —
 * and the phone still sat on the sign-in screen. Nothing errored. The user
 * simply tapped Sign in again, and again.
 *
 * The cause was navigation, not auth. **React Navigation preserves a focused
 * route across a conditional-screen swap when the route's name still exists in
 * the new configuration.** The signed-out gate was called `SignIn`, and the
 * signed-in stack legitimately keeps its own `SignIn` (the scanner pushes it
 * when a scanned QR names a different backend). So the session flipped, the
 * stack swapped, and the navigator went on rendering the very same route name.
 *
 * Mocking the navigator — which is what the screen-level tests do — cannot see
 * this. Only mounting one can.
 */

const Stack = createNativeStackNavigator<RootStackParamList>();

function Gate() {
  return <Text>gate screen</Text>;
}
function Devices() {
  return <Text>your laptops</Text>;
}
function PushedSignIn() {
  return <Text>pushed sign in</Text>;
}

/** The shape of `App.tsx`'s `Routes`, with the screens stubbed. */
function Routes({ signedIn, gateName }: { signedIn: boolean; gateName: 'SignIn' | 'SignInGate' }) {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName={signedIn ? 'Devices' : gateName}>
        {!signedIn ? (
          <Stack.Screen name={gateName} component={Gate} />
        ) : (
          <>
            <Stack.Screen name="Devices" component={Devices} />
            <Stack.Screen name="SignIn" component={PushedSignIn} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

describe('the auth gate', () => {
  it('moves to the laptops once a session appears', async () => {
    const view = render(<Routes signedIn={false} gateName="SignInGate" />);
    expect(await screen.findByText('gate screen')).toBeTruthy();

    await act(async () => {
      view.rerender(<Routes signedIn gateName="SignInGate" />);
    });

    await waitFor(() => expect(screen.getByText('your laptops')).toBeTruthy());
    expect(screen.queryByText('gate screen')).toBeNull();
  });

  /**
   * The exact defect, pinned. With the gate named `SignIn` — a name the
   * signed-in stack also uses — signing in leaves the user exactly where they
   * were. If this ever starts passing, the shared name is back.
   */
  it('does NOT move when the gate shares a name with a signed-in screen', async () => {
    const view = render(<Routes signedIn={false} gateName="SignIn" />);
    expect(await screen.findByText('gate screen')).toBeTruthy();

    await act(async () => {
      view.rerender(<Routes signedIn gateName="SignIn" />);
    });

    // The route survived the swap, so the navigator stayed on it — now
    // rendering the signed-in stack's `SignIn` screen instead of the laptops.
    await waitFor(() => expect(screen.getByText('pushed sign in')).toBeTruthy());
    expect(screen.queryByText('your laptops')).toBeNull();
  });
});
