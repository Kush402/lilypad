import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SessionProvider, useSession } from '../sessionContext';

/**
 * Signing out ends this phone's pairings on BOTH sides.
 *
 * The asymmetry this pins shut: sign-out wiped the pairs locally and told the
 * user "your paired laptops are removed from this phone", while every one of
 * those laptops went on listing this phone under "Paired phones" indefinitely.
 * Neither side could notice, because each was reading its own list.
 *
 * The local wipe already ended the pairing in fact — the per-pair connect
 * secret lives only on this phone and `reconcile` refuses to restore a pair it
 * holds no secret for — so this makes the backend agree rather than changing
 * what a sign-out does.
 */

const mockRequestUnpair = jest.fn(async (_apiBaseUrl: string, _desktopDeviceId: string) => true);
const mockClearSession = jest.fn(async () => {});
const mockForgetAllPairs = jest.fn(async () => {});
const mockLoadPairs = jest.fn(async () => [
  {
    desktopDeviceId: 'desktop-1',
    name: 'Work Mac',
    apiBaseUrl: 'https://a.test',
    connectSecret: 's1',
  },
  {
    desktopDeviceId: 'desktop-2',
    name: 'Home Mac',
    apiBaseUrl: 'https://b.test',
    connectSecret: 's2',
  },
]);

jest.mock('../api', () => ({
  requestUnpair: (base: string, id: string) => mockRequestUnpair(base, id),
}));
jest.mock('../pairs', () => ({
  forgetAllPairs: () => mockForgetAllPairs(),
  loadPairs: () => mockLoadPairs(),
}));
jest.mock('../auth', () => ({ invalidateAccessToken: jest.fn() }));
jest.mock('../session', () => ({
  clearSession: () => mockClearSession(),
  loadSession: async () => ({ email: 'ada@example.com', apiBaseUrl: 'https://a.test' }),
}));

function SignOutOnMount(): React.JSX.Element {
  const { session, signOut } = useSession();
  React.useEffect(() => {
    if (session) void signOut();
  }, [session, signOut]);
  return <Text>{session === null ? 'signed out' : 'signed in'}</Text>;
}

describe('signing out', () => {
  beforeEach(() => jest.clearAllMocks());

  it('severs every pairing on the backend, at the address each was made against', async () => {
    render(
      <SessionProvider>
        <SignOutOnMount />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed out')).toBeTruthy());

    expect(mockRequestUnpair).toHaveBeenCalledWith('https://a.test', 'desktop-1');
    expect(mockRequestUnpair).toHaveBeenCalledWith('https://b.test', 'desktop-2');
    expect(mockRequestUnpair).toHaveBeenCalledTimes(2);
  });

  /**
   * Order, not merely occurrence. `accessToken` refuses to use this device's
   * key against a backend that is not the session's, so clearing the session
   * first would make every unpair unauthenticated — a sign-out that appeared
   * to work and severed nothing.
   */
  it('unpairs before it forgets who was signed in', async () => {
    const order: string[] = [];
    mockRequestUnpair.mockImplementation(async () => {
      order.push('unpair');
      return true;
    });
    mockClearSession.mockImplementation(async () => {
      order.push('clearSession');
    });

    render(
      <SessionProvider>
        <SignOutOnMount />
      </SessionProvider>,
    );

    await waitFor(() => expect(order).toContain('clearSession'));
    expect(order.indexOf('clearSession')).toBe(order.length - 1);
    expect(order.filter((step) => step === 'unpair')).toHaveLength(2);
  });
});
