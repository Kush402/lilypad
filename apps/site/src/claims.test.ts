import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * The site's claims, checked against the rules the repository actually sets.
 *
 * A marketing page fails differently from an app: it does not crash, it lies.
 * It keeps saying "Windows supported" for months after someone decided the
 * Windows backend was not ready, and nobody notices because the page renders
 * perfectly. These tests are the cheapest guard against that, and each one
 * corresponds to a constraint written down elsewhere in the repo:
 *
 * - Platforms: `docs/PROJECT-INDEX.md` records Windows input as compile-complete
 *   but never executed, and Android as never hardware-verified. `docs/milestones.md`
 *   P4 therefore says macOS + iOS only.
 * - Prices: no price point, quota or allowance exists anywhere in the repo, and
 *   P4 renders `$XXXX` rather than inventing them.
 * - Ask's internal tier names stay off a public page, whatever the in-app
 *   surface does.
 */

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

/** The same HTML with runs of whitespace collapsed. Prettier line-wraps prose,
 * so a phrase-level assertion must not depend on where the wrap landed. */
const flat = html.replace(/\s+/g, ' ');

describe('platform claims', () => {
  it('presents macOS and iOS as supported', () => {
    for (const row of [/macOS[\s\S]{0,200}?tag--yes/, /iOS[\s\S]{0,200}?tag--yes/]) {
      expect(html).toMatch(row);
    }
  });

  // The specific failure this exists to prevent: someone adds a Windows build
  // to CI, updates the site, and ships a support claim ahead of the evidence.
  it.each(['Windows', 'Android'])('does not present %s as supported', (platform) => {
    const row = new RegExp(`>${platform}</th>[\\s\\S]{0,300}?</tr>`).exec(html);
    expect(row, `${platform} should appear in the platform table`).not.toBeNull();
    expect(row![0]).toContain('tag--no');
    expect(row![0]).not.toContain('tag--yes');
  });

  // v0.1.0 was published 2026-08-19, so the page may now offer a download. What
  // it must NOT do is imply the download is signed — see the distribution suite.
  it('links the release that actually exists', () => {
    expect(html).toMatch(/releases\/latest/);
  });
});

describe('pricing claims', () => {
  it('names exactly the three tiers the schema has', () => {
    const plans = [...html.matchAll(/<article class="plan">\s*<h3>([^<]+)<\/h3>/g)].map(
      (m) => m[1],
    );
    expect(plans).toEqual(['Free', 'Pro', 'Team']);
  });

  // `$XXXX` is the only permitted price. A real figure on this page would be an
  // offer the repository has no basis for making.
  it('quotes no price other than the placeholder', () => {
    const prices = [...html.matchAll(/\$[\w.,]+/g)].map((m) => m[0]);
    expect(prices.length).toBeGreaterThan(0);
    expect([...new Set(prices)]).toEqual(['$XXXX']);
  });

  it('says plainly that the prices are not set', () => {
    expect(html).toMatch(/prices are not set/i);
  });

  // The one pricing fact the repo does assert, in INFRASTRUCTURE-COST-MODEL.md:
  // "LAN is never paywalled."
  it('keeps the promise that local use is free', () => {
    expect(html).toMatch(/on your own network is always free/i);
  });
});

describe('distribution and relay claims match reality', () => {
  // Added 2026-08-19 after an audit found three claims the repository could not
  // support. Each assertion pins a fact that was VERIFIED, and must be relaxed
  // only when the underlying fact changes — not when the copy is reworded.

  // Verified: `security find-identity -v -p codesigning` offers only an "Apple
  // Development" certificate. Developer ID signing and notarization both
  // require a paid Apple Developer Program membership, which does not exist.
  it('does not claim the macOS build is signed or notarized', () => {
    const row = /<th scope="row">macOS<\/th>[\s\S]{0,300}?<\/tr>/.exec(html);
    expect(row).not.toBeNull();
    expect(row![0].replace(/\s+/g, ' ')).not.toMatch(/\bsigned and notarized\b/i);
    expect(flat).toMatch(/macOS[\s\S]{0,200}?not yet signed or notarized/i);
  });

  // Verified: the same missing membership means no TestFlight, so a customer
  // has no way to install the iPhone app at all.
  it('admits the iPhone app has no public install path', () => {
    const row = /<th scope="row">iOS<\/th>[\s\S]{0,300}?<\/tr>/.exec(html);
    expect(row).not.toBeNull();
    expect(row![0].replace(/\s+/g, ' ')).toMatch(/no public install path/i);
  });

  // Verified 2026-08-19: coturn is deployed at turn.takedia.com (Oracle Always
  // Free #2) and actually relays. Proof was four forced relay-only WebRTC
  // sessions — `iceTransportPolicy: 'relay'` on both peers, so a DataChannel
  // that opens cannot have taken a direct path — one per transport (UDP 3478,
  // TCP 3478, TLS 443) plus the exact ICE list the backend sends, each carrying
  // a payload through the relay. The credential for the last run was
  // minted inside the production backend container, which is what proves the
  // two halves share TURN_SECRET rather than merely being configured alike.
  //
  // This assertion replaced its own inverse. Until today the page said "no
  // relay is running yet"; the negative lookahead keeps that sentence from
  // creeping back after the fact stopped being true.
  it('claims relay fallback only because a relay is actually deployed', () => {
    expect(flat).toMatch(/the relay is live/i);
    expect(flat).not.toMatch(/no relay is running yet/i);
  });
});

describe('what the page must not say', () => {
  // Ask's internal tier vocabulary ("P1 skills", "P2 sandboxed codegen", …) is
  // an implementation detail. In-app it is fine — that surface is deliberately
  // unchanged (P5, closed) — but a public page describing the product to
  // strangers has no business carrying the engine's own vocabulary.
  it('does not leak Ask’s internal tier names', () => {
    expect(html).not.toMatch(/\bP[1-4]\b\s*(skills|codegen|accessibility|vision)/i);
  });

  // Linking a policy that does not exist is worse than not linking one.
  it('links no legal pages, because none are written', () => {
    expect(html).not.toMatch(/href="[^"]*(privacy|terms|legal)[^"]*"/i);
    expect(html).toMatch(/not written yet/i);
  });

  // The product's own non-negotiable, and the reason the security section leads
  // with linking rather than with sign-in.
  it('does not promise that an account finds your computers', () => {
    expect(html).toMatch(/[Ss]igning in does not reveal a computer/);
  });
});
