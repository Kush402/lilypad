---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-26
summary: The five windows the Mac app can show, what each one is for, and the rule that decides which of them a given control belongs in.
---

# The Mac app's screens

Five windows, one bundle. `App.tsx` renders by window label; Rust opens them
(`commands::open_window`) and hides rather than closes the others, so a window
that has been opened once stays alive, unmounted from nobody's view, for the
rest of the run.

**That last sentence is the reason this file exists.** A hidden window keeps
whatever it read the last time it was mounted. Anything read once on mount is
not "current", it is "whenever this window first opened" — which is how the
dashboard came to say "Signed in as ada@example.com" while Settings, open at the
same time, asked the same person to sign in.

```
                     ┌─────────────┐
                     │  menu bar   │  always there, never hides
                     │    tray     │
                     └──────┬──────┘
        ┌───────────────────┼───────────────────┬──────────────┐
        │                   │                   │              │
   ┌────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐  ┌────▼──────┐
   │  bubble  │─────▶│   control   │◀───▶│    setup    │  │diagnostics│
   │  108px   │      │ "Lilypad"   │     │  wizard ⇄   │  │           │
   │ floating │      │  DASHBOARD  │     │  SETTINGS   │  │  support  │
   └──────────┘      └──────┬──────┘     └──────┬──────┘  └───────────┘
                            │                   │
                            └────────┬──────────┘
                                     │  "Pair a phone"
                              ┌──────▼──────┐
                              │  qr-overlay │
                              │   the code  │
                              └─────────────┘
```

## Which window does a control belong in?

One question decides it: **is this something you watch, or something you set?**

| Window          | Is for                                                                                                                                                         | Never carries                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **bubble**      | Being visible. One click to the dashboard.                                                                                                                     | Anything with more than one outcome. |
| **control**     | What is happening right now: session, approve/deny, disconnect, panic, who is signed in, which phones are paired, whether a phone can reach this Mac.          | Anything irreversible.               |
| **setup**       | What this Mac is configured to be: the account, macOS permissions, Ask AI, pairing. Both the first-run wizard and the settings window, decided once per mount. | A live session's controls.           |
| **qr-overlay**  | One code, for one pairing, for 120 seconds.                                                                                                                    | Anything that outlives the code.     |
| **diagnostics** | What to send support.                                                                                                                                          | Anything that changes state.         |

The rule has one visible consequence: **Delete account is in Settings and not on
the dashboard.** The dashboard is the window that is open while a phone is
connected to this Mac, and the most destructive control in the product was
sitting one row under the running session. Sign out stays on both — it is
reversible, and it is what people look for.

Signed OUT, both windows show the whole sign-in form. A dashboard nobody can
sign in from is a dead end, and sending someone to a second window to do the one
thing blocking them is the same hole in a different place.

## The rule for state

**Read on an event, never only on mount.** Every window subscribes through
`useTauriEvent`, and Rust emits when the answer changes:

| Event                  | Emitted by                                                                                                     | Windows re-read                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `lilypad://session`    | the session runner, and `presence.rs` when reachability changes                                                | the whole `AppStateDto` snapshot            |
| `lilypad://account`    | `commands::announce_account` — sign-in, sign-up, reset, sign-out, delete, and the rollback of a failed sign-in | who is signed in, and this Mac's link state |
| `lilypad://permission` | `commands::show_setup`'s poll, while the setup window is visible                                               | the two macOS permissions                   |

Adding a new fact that two windows can both show means adding it to this table.
A mount-only read is a bug that only appears once somebody opens the second
window.

## Where the first run ends

The wizard's last card opens the dashboard and closes itself. Both halves
matter: it used to say **Done** and close, which left a first-run customer
looking at their own desktop with the app they had just set up nowhere in
sight — and the close is what makes the next open of that window decide `mode`
again, so a finished wizard comes back as **Settings** rather than re-numbering
steps somebody has already done.
