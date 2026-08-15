import { AccountPanel } from './AccountPanel';

/**
 * "Add this computer to your account" — but only once there is an account in
 * play on this machine.
 *
 * **Why this gate exists.** Linking does not technically require the desktop to
 * be signed in: a signed-in PHONE scans the code and that phone's account
 * adopts the machine ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md),
 * [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)). It works
 * signed out and always has.
 *
 * The gate is a **product ordering decision**, and the dashboard was wrong
 * without it. Signed out, the screen offered "Sign in to Lilypad" and, directly
 * beneath it, a live enrollment QR counting down — the last step of a flow
 * whose first step had not happened, with nothing on screen relating the two.
 * It read as a second, competing way to sign in. A user could reasonably scan
 * it expecting to be logged in on the Mac, and instead put the machine on
 * whichever account their phone happened to be holding.
 *
 * So: identity first, then the computer. The copy says the order plainly and
 * does not claim a dependency that is not there — and it keeps pairing
 * visible, because pairing genuinely needs no account at all and hiding it
 * would be the opposite mistake.
 */
export function LinkStep({ signedIn }: { signedIn: boolean }) {
  if (signedIn) return <AccountPanel />;

  return (
    <section className="control__account card" data-testid="link-step-locked">
      <h2 className="section-title">This computer</h2>
      <p className="muted">
        Sign in above first. Linking is what puts this Mac on your account, so there has to be an
        account on this Mac to put it on.
      </p>
      <p className="muted">
        You can still pair a phone without any of this — pairing and linking are different things,
        and only linking needs an account.
      </p>
    </section>
  );
}
