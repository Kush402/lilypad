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
 * So: identity first, then the computer, then the phone.
 *
 * This panel's first version told the user "you can still pair a phone without
 * any of this", which was true of the code and wrong about the product: a pair
 * made on an unlinked machine belongs to no account, appears in nobody's "Your
 * devices", and can be revoked from nowhere — the state
 * [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md) rejected in
 * so many words ("without an owner there is nothing to authorize against, no
 * revocation story across devices"). `docs/api.md` already recorded the
 * backend's unowned lane as a migration allowance that ends "when P1 makes
 * enrolment mandatory". Pairing now waits for linking, and the copy says so.
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
        Pairing a phone comes after this. A phone paired with a computer that is on no account can’t
        be seen or removed from anywhere, so linking goes first.
      </p>
    </section>
  );
}
