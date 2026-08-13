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
 * - Ask's internal tier names are internal (P5).
 */

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

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

  it('never calls itself available for download while no release exists', () => {
    // Reworded only when a release genuinely exists; `gh release list` is empty.
    expect(html).toMatch(/no public release yet/i);
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

describe('what the page must not say', () => {
  // Ask's internal tier vocabulary ("P1 skills", "P2 sandboxed codegen", …) is
  // an implementation detail; P5 exists to keep it off user-facing surfaces.
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
