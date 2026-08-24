import { useState } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { api } from '../lib/tauri';
import { useAppState } from '../lib/useAppState';
import { STATUS_COLOR, STATUS_ARIA_LABEL } from '../lib/status';

/** Bring an already-open window forward, if it exists. Never creates one —
 * that's `api.createPairing()`'s job, and only from `idle`. */
async function focusWindow(label: string): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel(label);
    await win?.show();
    await win?.setFocus();
  } catch {
    /* not running inside Tauri, or the window doesn't exist (yet) */
  }
}

/**
 * The always-on-top floating "Lilypad" bubble. Its click target is a state
 * machine, not a single action, because the bubble is the one control
 * surface a user is most likely to reflexively click at any point in a
 * session's lifecycle:
 *
 *  - `idle` → start a new pairing (today's original behavior).
 *  - `pairing` / `awaiting_approval` / `active` → reopen the existing
 *    QR/Control window instead of starting a second pairing flow.
 *
 * Previously `onPair` called `api.createPairing()` unconditionally on every
 * click regardless of status. During an ACTIVE session that silently
 * disconnected the connected phone: `create_pairing` always spawns a new
 * session runner, which overwrites `AppState.control_tx` — dropping the old
 * sender, which the running session interprets identically to an explicit
 * Disconnect. A single accidental click destroyed a live session with zero
 * confirmation. See `docs/audit/m3/desktop-ux.md` Findings 3 and 4 (the
 * latter because reopening the Control window is also the bubble's
 * always-reachable path to the Disconnect/Panic buttons — the one thing a
 * user reaching for the bubble mid-session most likely wants).
 */
export function Bubble() {
  const state = useAppState();
  const status = state?.session ?? 'idle';
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    switch (status) {
      case 'idle': {
        setBusy(true);
        try {
          // The dashboard, NOT the pairing QR.
          //
          // Clicking the bubble used to mint a pairing code and put a QR on
          // screen as the app's very first act — before any account existed,
          // before the user had seen a single screen explaining what Lilypad
          // is, and before there was anywhere to find out. A QR is the LAST
          // step of setup, not the front door.
          //
          // The dashboard leads with who you are, then which computer is
          // yours, and carries its own "Pair a new device" button, so pairing
          // is one click further away and one click after the two things that
          // give it meaning.
          await api.showControl();
        } catch (err) {
          console.error('showControl failed', err);
        } finally {
          setBusy(false);
        }
        return;
      }
      case 'pairing':
        await focusWindow('qr-overlay');
        return;
      case 'awaiting_approval':
      case 'connecting':
      case 'active':
        // All three route to Control: it shows the approve/deny prompt while
        // awaiting, an honest "Connecting…" state while negotiating, and the
        // Disconnect/Panic controls once active — never `createPairing()`
        // again while already mid-flow. Uses `api.showControl()`
        // (create-if-absent, else focus) rather than `focusWindow`, since a
        // trusted phone's silent auto-reconnect never creates the Control
        // window in the first place.
        await api.showControl();
        return;
    }
  };

  return (
    <div className="bubble-root" data-tauri-drag-region>
      <button
        className={`bubble ${busy ? 'bubble--busy' : ''}`}
        onClick={() => void onClick()}
        title={STATUS_ARIA_LABEL[status]}
        aria-label={STATUS_ARIA_LABEL[status]}
      >
        {/* The mark, not the 🪷 emoji this used to render. An emoji is drawn
         * by whichever font the OS ships, so it changed shape between macOS
         * versions and matched nothing else in the product — least of all the
         * app icon, which is this shape. Same geometry as
         * `scripts/icons.py`: a disc with a wedge cut to the rim. */}
        <svg className="bubble__pad" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 12 L20.25 7.71 A9.3 9.3 0 1 1 18.16 5.04 Z" />
        </svg>
        <span className="bubble__dot" style={{ backgroundColor: STATUS_COLOR[status] }} />
        {/* Color-only status fails WCAG 1.4.1 for colorblind/screen-reader
         * users — this text alternative isn't visible but is announced.
         * See docs/audit/m3/desktop-ux.md Finding 14. */}
        <span className="sr-only">{STATUS_ARIA_LABEL[status]}</span>
      </button>
    </div>
  );
}
