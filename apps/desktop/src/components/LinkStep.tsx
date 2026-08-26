import { AccountPanel } from './AccountPanel';

/**
 * Whether this computer is on an account — but only once there is an account in
 * play on this machine.
 *
 * Signing in is what puts a Mac on an account
 * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)), so
 * signed out there is nothing to report and nothing to do here. The panel this
 * gate protects is a status card plus a recovery QR, and both are meaningless
 * before anyone has said who they are.
 *
 * **The gate predates the status card and is worth keeping.** Adopting a Mac by
 * QR does not technically require the desktop to be signed in: a signed-in
 * PHONE scans the code and that phone's account takes the machine
 * ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)). It
 * works signed out and always has — which is exactly the problem. Signed out,
 * the dashboard offered "Sign in to Lilypad" and, directly beneath it, a live
 * QR counting down, with nothing on screen relating the two. It read as a
 * second, competing way to sign in. Someone could reasonably scan it expecting
 * to be logged in on the Mac, and instead put the machine on whichever account
 * their phone happened to be holding.
 *
 * So: identity first, then the computer, then the phone.
 */
export function LinkStep({ signedIn, onLinked }: { signedIn: boolean; onLinked?: () => void }) {
  if (signedIn) return <AccountPanel onLinked={onLinked} />;

  return (
    <section className="control__account card" data-testid="link-step-locked">
      <h2 className="section-title">This computer</h2>
      <p className="muted">
        Sign in above first. Signing in is what puts this Mac on your account, and there has to be
        an account on this Mac to put it on.
      </p>
    </section>
  );
}
