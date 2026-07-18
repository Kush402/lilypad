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
          // Open the overlay only — the overlay's mount effect is the single
          // caller of `create_pairing` (previously both fired, minting two
          // rooms per click and risking a QR for an already-dead room).
          await api.showQrWindow();
        } catch (err) {
          console.error('showQrWindow failed', err);
        } finally {
          setBusy(false);
        }
        return;
      }
      case 'pairing':
        await focusWindow('qr-overlay');
        return;
      case 'awaiting_approval':
      case 'active':
        // Both cases route to Control: it shows the approve/deny prompt
        // while awaiting, and the Disconnect/Panic controls once active —
        // never `createPairing()` again while already mid-flow.
        await focusWindow('control');
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
        <span className="bubble__pad">🪷</span>
        <span className="bubble__dot" style={{ backgroundColor: STATUS_COLOR[status] }} />
        {/* Color-only status fails WCAG 1.4.1 for colorblind/screen-reader
         * users — this text alternative isn't visible but is announced.
         * See docs/audit/m3/desktop-ux.md Finding 14. */}
        <span className="sr-only">{STATUS_ARIA_LABEL[status]}</span>
      </button>
    </div>
  );
}
