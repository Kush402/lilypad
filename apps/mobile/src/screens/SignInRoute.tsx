import React, { useCallback } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { SignInScreen } from './SignInScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'SignIn'>;

/**
 * Navigation wrapper for the presentational `SignInScreen` (P1).
 *
 * Sign-in is always pushed ON TOP of whatever needed it — today the scanner,
 * holding a link code it could not use yet. Going back therefore returns to
 * that still-mounted screen with its scanned code intact, so the user finishes
 * the action they had already started rather than re-scanning.
 */
export function SignInRoute({ route, navigation }: Props): React.JSX.Element {
  const onSignedIn = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  return <SignInScreen apiBaseUrl={route.params.apiBaseUrl} onSignedIn={onSignedIn} />;
}
