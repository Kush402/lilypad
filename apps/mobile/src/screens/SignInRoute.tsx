import React, { useCallback } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { SignInScreen } from './SignInScreen';
import { useSession } from '../lib/sessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'SignIn'>;

/**
 * Navigation wrapper for the presentational `SignInScreen`.
 *
 * This route is reached two ways, and both have to work:
 *
 *  - **As the gate** (P3), when nobody is signed in. There is nothing to go
 *    back to — it is the only screen in the stack — so finishing means
 *    refreshing the session, which swaps the whole stack for the signed-in one.
 *  - **Pushed on top of the scanner**, holding a link code it could not use
 *    yet. Going back returns to that still-mounted screen with its scanned code
 *    intact, so the user finishes the action they had already started rather
 *    than re-scanning.
 *
 * Hence: always refresh, then go back only if there is a back to go to.
 */
export function SignInRoute({ route, navigation }: Props): React.JSX.Element {
  const { refresh } = useSession();

  const onSignedIn = useCallback(() => {
    void refresh().then(() => {
      if (navigation.canGoBack()) navigation.goBack();
    });
  }, [navigation, refresh]);

  return <SignInScreen apiBaseUrl={route.params?.apiBaseUrl} onSignedIn={onSignedIn} />;
}
