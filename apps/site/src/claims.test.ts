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
const privacy = readFileSync(fileURLToPath(new URL('../privacy.html', import.meta.url)), 'utf8');
const terms = readFileSync(fileURLToPath(new URL('../terms.html', import.meta.url)), 'utf8');

/** The same HTML with runs of whitespace collapsed. Prettier line-wraps prose,
 * so a phrase-level assertion must not depend on where the wrap landed. */
const flat = html.replace(/\s+/g, ' ');

/** The version the desktop app is actually built at — the same field
 * `pnpm release` bumps and `tauri-action` names the DMG after. */
const shippedVersion: string = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url)),
    'utf8',
  ),
).version;

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
  it('offers a download this site actually serves', () => {
    expect(html).toMatch(/href="\/download\/Lilypad\.dmg"/);
  });

  // The page pointed at github.com/Kush402/lilypad/releases/latest for its
  // whole life. The repository was private, so every one of those links
  // answered 404 to anyone who was not signed in with access: both the download
  // button and the updater manifest were dead for every real visitor, and it
  // looked fine from inside because an authenticated browser resolves them.
  //
  // The repository became public on 2026-08-23 and those URLs would now
  // resolve. The rule stays anyway, because the incident was never really about
  // one setting's value — it was about a customer-facing URL depending on a
  // setting at all. One click puts it back, and nothing here would fail.
  it('sends nobody to a host that requires an account', () => {
    expect(html).not.toMatch(/github\.com/i);
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

  // This used to assert the OPPOSITE — that no legal page was linked, because
  // linking a policy that does not exist is worse than not linking one. They
  // exist now, so the guard becomes: they are reachable, and they do not lie.
  it('links the legal pages it now has', () => {
    expect(html).toMatch(/href="\/privacy\.html"/);
    expect(html).toMatch(/href="\/terms\.html"/);
    expect(html).not.toMatch(/not written yet/i);
  });

  // The product's own non-negotiable, and the reason the security section leads
  // with linking rather than with sign-in.
  it('does not promise that an account finds your computers', () => {
    expect(html).toMatch(/[Ss]igning in does not reveal a computer/);
  });
});

/**
 * The page shipped saying "Not yet released publicly" in its hero while
 * linking a public v0.1.1 download further down the same page. Both cannot be
 * true, and the visitor reads the hero first — so the honest half was the one
 * nobody saw. A page that contradicts itself is worse than either claim alone.
 */
describe('release status', () => {
  it('does not say it is unreleased while offering a download', () => {
    expect(html).not.toMatch(/not yet released publicly/i);
  });

  it('names the version it actually offers, and does not overstate its trust', () => {
    // Read the shipped version rather than hard-coding it. The page once
    // advertised v0.1.1 for forty-two commits after main had moved on, and a
    // literal in this test is exactly what let that pass: it asserted the page
    // was consistent with the test, not with the build a visitor downloads.
    expect(html).toContain(`v${shippedVersion}`);
    // Builds are ad-hoc signed from 0.1.4 — enough for macOS to bind a TCC
    // grant, not enough for Gatekeeper — so the page must still warn. It may
    // stop only when a Developer ID build is notarized.
    expect(html).toMatch(/not notarized|unsigned|not signed/i);
  });

  it('still tells iPhone users there is no install path', () => {
    expect(html).toMatch(/built from source/i);
  });
});

/**
 * The legal pages describe what the code does. A page that drifts from the
 * code is worse than no page: it is a claim, in public, that is false.
 *
 * These check the handful of statements that are checkable from here. The
 * rest — retention windows, what the relay can see — are pinned against the
 * constants that implement them.
 */
describe('the legal pages', () => {
  it('ship as real pages, not placeholders', () => {
    for (const [name, page] of [
      ['privacy', privacy],
      ['terms', terms],
    ] as const) {
      // The `$XXXX` problem, generalised: a placeholder that reaches
      // production is a promise nobody made.
      expect(page, name).not.toMatch(/XXXX|TODO|TBD|Lorem ipsum|\[insert/i);
      expect(page, name).toMatch(/Last updated \d{1,2} \w+ 20\d\d/);
    }
  });

  it('gives a way to make contact, on a domain that is ours', () => {
    // A policy with no contact is not a policy. A contact on someone else's
    // domain is a different problem.
    for (const page of [privacy, terms, html]) {
      expect(page).toMatch(/mailto:[^"]+@takedia\.com/);
    }
  });

  // Proven against production on 2026-08-23: the deployed pages served
  // `<a href="/cdn-cgi/l/email-protection#8af9...">[email&#160;protected]</a>`
  // where the source says `mailto:support@takedia.com`. Cloudflare's Email
  // Obfuscation rewrites every address in the HTML and restores it with
  // JavaScript, so the one address a privacy page exists to publish was
  // unreadable without JS, uncopyable, and un-parseable by anything that is
  // not a browser. `<!--email_off-->` is Cloudflare's documented per-element
  // opt-out and is the only lever we hold from inside the repository.
  //
  // It also made the `site` workflow's byte comparison permanently red: the
  // obfuscation key is re-randomised per request, so the live HTML never
  // matched the build that produced it. One cause, two failures.
  it('publishes its contact address in a form Cloudflare will not rewrite', () => {
    for (const [name, page] of [
      ['privacy', privacy],
      ['terms', terms],
      ['index', html],
    ] as const) {
      for (const match of page.matchAll(/<a href="mailto:[^"]+">[^<]*<\/a>/g)) {
        const at = match.index ?? 0;
        expect(page.slice(Math.max(0, at - 20), at), name).toContain('<!--email_off-->');
        expect(page.slice(at + match[0].length, at + match[0].length + 20), name).toContain(
          '<!--email_on-->',
        );
      }
    }
  });

  it('states the retention windows the code actually implements', () => {
    // `AUDIT_RETENTION_DAYS = 2` in the backend; `-mtime +7` in backup.sh.
    // If either moves, this page becomes a false statement about real data.
    expect(privacy).toMatch(/2 days/);
    expect(privacy).toMatch(/7 days/);
  });

  it('does not claim the server cannot see something it could', () => {
    // The honest claim is that media is end-to-end encrypted and the relay
    // forwards packets it has no key for — NOT that traffic never passes
    // through the operator's infrastructure, which would be false whenever
    // TURN is used.
    expect(privacy).toMatch(/relay/i);
    expect(privacy).not.toMatch(/never (passes|goes) through (our|the) (server|relay)/i);
  });

  it('does not overstate the maturity of a one-person service', () => {
    expect(terms).toMatch(/no uptime guarantee|no warranty/i);
    expect(privacy).toMatch(/one person/i);
  });

  it('links back to each other and home, so neither is a dead end', () => {
    expect(privacy).toMatch(/href="\/terms\.html"/);
    expect(terms).toMatch(/href="\/privacy\.html"/);
    expect(privacy).toMatch(/href="\/"/);
    expect(terms).toMatch(/href="\/"/);
  });
});
