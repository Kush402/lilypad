import { useEffect, useState } from 'react';
import { IconClose } from './Icon';
import { updater } from '../lib/tauri';
import { useUpdater } from '../lib/useUpdater';

/**
 * The updater UI, in two shapes driven by the same `useUpdater` state machine:
 *
 * - `banner` — the launch-time, non-intrusive prompt. Runs one silent check on
 *   mount and renders NOTHING until an update is actually available (so a
 *   healthy up-to-date launch is invisible). Dismissable.
 * - `panel` — the always-visible "Software update" section in Diagnostics with
 *   the current version and a manual "Check for updates" affordance.
 *
 * Both share the download → install → relaunch flow.
 */
export function SoftwareUpdate({ variant }: { variant: 'banner' | 'panel' }) {
  const auto = variant === 'banner';
  const { state, check, downloadAndInstall, relaunch, retry } = useUpdater({ auto });
  const [dismissed, setDismissed] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void updater
      .currentVersion()
      .then((v) => {
        if (alive) setCurrentVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const { phase, newVersion, notes, progress, error, failedStep } = state;

  /** Says which step broke, because "update check failed" after a download
   * died halfway is the wrong sentence and sends the reader looking in the
   * wrong place. */
  const failureText =
    failedStep === 'download'
      ? `Couldn’t download the update. ${error}`
      : `Couldn’t check for updates. ${error}`;
  const busy = phase === 'downloading';

  const actions = (
    <div className="row update__actions">
      {phase === 'available' ? (
        <button className="btn btn--primary btn--small" onClick={() => void downloadAndInstall()}>
          Download &amp; install
        </button>
      ) : null}
      {phase === 'downloading' ? (
        <button className="btn btn--small" disabled>
          {progress != null ? `Downloading… ${Math.round(progress * 100)}%` : 'Downloading…'}
        </button>
      ) : null}
      {phase === 'ready' ? (
        <button className="btn btn--primary btn--small" onClick={() => void relaunch()}>
          Restart to update
        </button>
      ) : null}
      {/* Without this, a failed download was a dead end: the banner showed a
          message and no button, and the update stayed unavailable until the
          app was restarted. A failed download retries the download; a failed
          check re-checks. */}
      {phase === 'error' ? (
        <button
          className="btn btn--primary btn--small"
          data-testid="update-retry"
          onClick={() => void retry()}
        >
          Try again
        </button>
      ) : null}
    </div>
  );

  // Banner: silent unless there's something actionable to show.
  if (variant === 'banner') {
    const actionable =
      phase === 'available' || phase === 'downloading' || phase === 'ready' || phase === 'error';
    if (!actionable || dismissed) return null;
    return (
      <section className="update-banner card" role="status">
        <div className="update-banner__body">
          {phase === 'error' ? (
            <p className="update__msg">{failureText}</p>
          ) : phase === 'ready' ? (
            <p className="update__msg">
              <strong>Lilypad {newVersion}</strong> is ready to install.
            </p>
          ) : (
            <p className="update__msg">
              <strong>Lilypad {newVersion}</strong> is available.
            </p>
          )}
          {actions}
        </div>
        {!busy ? (
          <button
            className="update-banner__dismiss"
            aria-label="Dismiss update notice"
            onClick={() => setDismissed(true)}
          >
            <IconClose />
          </button>
        ) : null}
      </section>
    );
  }

  // Panel (Diagnostics): always visible, with the manual check affordance.
  return (
    <section className="control__update card">
      <div className="section-title-row">
        <h2 className="section-title">Software update</h2>
        <button
          className="btn btn--small"
          disabled={phase === 'checking' || busy}
          onClick={() => void check()}
        >
          {phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      <div className="status-row">
        <span className="status-row__label">Current version</span>
        <span className="status-row__value mono">{currentVersion ?? 'unknown'}</span>
      </div>

      {phase === 'uptodate' ? (
        <p className="muted update__msg">You’re on the latest version.</p>
      ) : null}
      {phase === 'error' ? <p className="muted update__msg">{failureText}</p> : null}
      {phase === 'available' || phase === 'downloading' || phase === 'ready' ? (
        <>
          <p className="update__msg">
            {phase === 'ready' ? (
              <>
                <strong>Version {newVersion}</strong> downloaded. Restart to finish.
              </>
            ) : (
              <>
                <strong>Version {newVersion}</strong> is available.
              </>
            )}
          </p>
          {notes ? <pre className="update__notes muted">{notes}</pre> : null}
        </>
      ) : null}

      {actions}
    </section>
  );
}
