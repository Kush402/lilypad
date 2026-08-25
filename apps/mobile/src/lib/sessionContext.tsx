import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearSession, loadSession, type StoredSession } from './session';
import { invalidateAccessToken } from './auth';
import { forgetAllPairs, loadPairs } from './pairs';
import { requestUnpair } from './api';

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
  /** Sign out on this phone: sever its pairings on both sides, forget the
   * session record, and drop any cached device token. Does NOT revoke this
   * device on the account — that is what "Your devices" is for. */
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
    // Sever the pairings on the LAPTOPS too, not only here.
    //
    // Wiping them locally alone left the two sides disagreeing: this phone
    // showed no laptops while every one of those laptops went on listing this
    // phone under "Paired phones", forever, with no way for either owner to
    // notice. The sign-out sheet said "your paired laptops are removed from
    // this phone", which was true and read as the whole story.
    //
    // The local wipe is not optional and cannot be undone by a later sign-in:
    // the per-pair connect secret lives only here and is never re-issued
    // (`reconcile` refuses to restore a pair it holds no secret for), so a
    // sign-out already ends every pairing in practice. This makes the backend
    // agree rather than changing what happens.
    //
    // FIRST, while this phone can still prove who it is — `clearSession` is
    // what `accessToken` reads to decide it may use this device's key against
    // this backend. `requestUnpair` never throws and times out on its own, so
    // an offline sign-out still completes; the laptop can revoke from its side.
    const pairs = await loadPairs();
    await Promise.all(pairs.map((p) => requestUnpair(p.apiBaseUrl, p.desktopDeviceId)));
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
