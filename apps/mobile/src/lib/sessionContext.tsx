import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearSession, loadSession, type StoredSession } from './session';
import { invalidateAccessToken } from './auth';
import { forgetAllPairs } from './pairs';

/**
 * Who is signed in on this phone, for the whole app.
 *
 * The gate this exists for: **account and device functionality require an
 * authenticated phone.** Before P3 the app opened straight onto the paired-
 * laptop list and every account feature was reachable — or hidden — purely by
 * whether a laptop happened to be paired. Sign-in was a detour the scanner
 * pushed when a call happened to fail.
 *
 * `undefined` means the first read has not landed yet, and is deliberately not
 * the same as `null`. Treating "still loading" as "signed out" would flash the
 * sign-in screen at every already-signed-in user on every cold start.
 */

interface SessionContextValue {
  session: StoredSession | null | undefined;
  /** Re-read after a sign-in. */
  refresh: () => Promise<void>;
  /** Sign out on this phone: forget the session record and the paired laptops,
   * and drop any cached device token. Does NOT revoke this device on the
   * account — that is what "Your devices" is for, and doing it here would make
   * every sign-out destroy trust relationships the user did not ask to lose. */
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<StoredSession | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    setSession(await loadSession());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await clearSession();
    await forgetAllPairs();
    invalidateAccessToken();
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, refresh, signOut }), [session, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession used outside SessionProvider');
  return value;
}
