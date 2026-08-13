---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-13
summary: Why colour lives in one package shared by all three surfaces, and why font sizes and spacing deliberately do not.
---

# ADR-0011 — One palette, three surfaces

## Context

Lilypad renders on three front ends: the Tauri desktop app, the React Native
phone app, and the admin dashboard. Until P3, each carried its own copy of the
palette:

| Surface | Where the palette lived                              | Form              |
| ------- | ---------------------------------------------------- | ----------------- |
| Desktop | `apps/desktop/src/styles.css` (`:root` + dark block) | CSS properties    |
| Mobile  | `apps/mobile/src/theme.ts`                           | TypeScript object |
| Admin   | `apps/admin/src/styles.css` (`:root`)                | CSS properties    |

Three copies of the same seven hexes is not a style choice; it is three chances
to drift. It had already drifted in four places, all found by grepping for
colour literals rather than by anyone noticing on screen:

1. **`#06231a`**, the text on a filled accent button, was written out eight
   times across five files — and once as `#04140d` in the agent panel, a
   near-identical near-black that no one could have chosen deliberately.
2. **"Waiting on a human"** was `#e0a83e` in the agent panel and `#f5a623` in
   the connection-quality meter, while the desktop already called that state
   `--pending` and used a third value for it in light mode.
3. **The desktop's status dots** used Apple's system green and amber
   (`#34c759`, `#ff9f0a`) — a second green and a second amber for meanings the
   palette already had colours for.
4. **`SignInScreen` was on no palette at all**: no background colour, so it
   rendered white while every other screen is dark green, with `#ccc` borders
   and a Material red error. It is the first screen a new user sees.

## Decision

**Colour, corner radii and the font stack move to `@lilypad/design` and are
shared by all three surfaces.** Web surfaces `@import '@lilypad/design/tokens.css'`;
mobile imports the TypeScript module. No surface declares a **palette** colour
literal — the exceptions are the three listed under Consequences, each of which
is a colour that must not follow the theme.

**Font sizes and spacing stay in each surface's own stylesheet.** They are not
duplicated — they are genuinely different, and for a reason: the web surfaces
are hand-tuned around 11–18px and mobile around 13–26pt, because a phone is
held at arm's length and a laptop is not. A single shared numeric scale would
have to move one of them, which is a redesign rather than a de-duplication, and
P3 is not a licence to re-tune shipped screens. What was genuinely duplicated
in that area — the `system-ui, -apple-system, …` stack, written out identically
in two stylesheets — is in the package.

### The CSS file is checked in, not generated

`tokens.css` could be emitted from `tokens.ts` at build time, which would make
drift impossible. It is hand-written instead, because a generated stylesheet
would have to exist before Vite could resolve the import — and `turbo run dev`
does not build dependencies first. A developer running `pnpm dev` on a clean
checkout would hit an unresolved `@import` rather than a running app.

The cost of that choice is paid by `src/tokens.test.ts`, which parses the
shipped CSS and fails if it disagrees with the TypeScript in either direction:
a colour that differs, a dark override that is missing, or a custom property
with no TypeScript counterpart. That last case matters most — it is the same
drift arriving from the CSS side, where mobile cannot see it.

## Alternatives

**Generate the CSS from the TypeScript.** Rejected for the `pnpm dev` ordering
problem above. The drift test buys back the guarantee at a much lower cost than
a build-order dependency on every stylesheet.

**Give mobile its own copy and share only between the two web surfaces.**
Rejected: mobile is the surface where the drift actually happened, so excluding
it would leave the problem exactly where it was.

**One numeric scale for type and spacing across web and native.** Rejected —
see the Decision above. This is the part of "a design system" that is most
tempting to build and least justified by evidence here; nothing in the repo
suggests the current sizes are wrong, only that they are different.

## Consequences

**The admin dashboard now follows the OS colour scheme.** It hardcoded the dark
palette; every rule in it already read `var(--*)`, so importing the shared
tokens gave it the desktop's light/dark behaviour. The values it renders are
unchanged — but an operator on a light-mode Mac now sees a light dashboard where
they used to see a dark one. This is a visible change and a deliberate one: the
alternative was to keep a private copy of seven hexes, which is the exact
problem this ADR exists to remove.

**Two colours converged, deliberately.** `#04140d` became `#06231a`, and
`#e0a83e` became `#f5a623`. Both are small shifts within the same hue; both
replace an accident with a decision.

**Mobile stays dark-only.** It takes the `dark` scheme directly rather than
following the OS, because it renders full-bleed video and light chrome around a
dark picture is worse, not merely different.

**Three things are deliberately exempt**, and they are the only remaining colour
literals in the codebase.

- **Vendor sign-in buttons.** Apple's and Google's buttons are brand assets with
  published appearance rules; a palette is not licence to restyle them. Apple's
  white style is used because it is the permitted style that stays legible on a
  dark background — the previous black-on-near-black would have all but
  disappeared once the screen took its background colour.
- **The floating bubble.** It sits in a transparent window over whatever the
  user has on screen, so its gradient, outline ring and pulse halo are
  scheme-independent literals. Reading `--bg` there would turn the ring
  near-white on a light desktop and erase the separation it exists to provide.
- **The QR code's white frame.** A QR needs a light quiet zone to scan
  reliably; tinting it with `--panel` would make the code harder to read in one
  scheme, which is a functional regression rather than a stylistic one.

Four dead `var(--token, #fallback)` fallbacks were removed while doing this.
They could never fire — the tokens are unconditionally defined — and each held a
stale dark-only value that would have been wrong in light mode if it ever had.

## Status

**Accepted 2026-08-13**, implemented as milestone P3. Colour, radii and the font
stack are shared; type and spacing are explicitly out of scope and stay per
surface, which is a decision rather than unfinished work.

## References

- `packages/design/src/tokens.ts` — the tokens, with the provenance of each.
- `packages/design/src/tokens.test.ts` — the drift test.
- [ADR-0008](0008-desktop-enrollment-via-phone.md) — why the phone owns the
  account surface, hence why `SignInScreen`'s appearance matters as much as it does.
- `docs/audit/m3/desktop-ux.md` Findings 13 and 16 — the earlier decisions to
  centralise theming and to keep "being observed" distinct from "destructive".
