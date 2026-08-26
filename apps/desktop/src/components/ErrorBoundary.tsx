import React from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * The last thing between a render error and a blank window.
 *
 * Without this, a thrown error inside any window unmounts the whole tree and
 * React leaves an empty document behind. On the bubble that is a 108-pixel
 * transparent hole sitting on top of everything with no way to close it; on the
 * dashboard it is a white rectangle. Neither says anything, neither writes
 * anything down, and the "Copy for support" report the customer is then asked
 * for describes an app that looks fine.
 *
 * Errors are reported the same way the rest of the product reports: to the log
 * on this Mac, and nowhere else. Nothing is transmitted. The customer decides
 * whether any of it is shared, from Diagnostics, as they always have.
 */
interface Props {
  children: React.ReactNode;
  /** Which window this is, so the log line says where it happened. */
  where: string;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const detail = `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${
      info.componentStack ?? ''
    }`;
    // Both, and for different readers. The console is for whoever has the
    // inspector open; `log_ui_error` is the one that reaches
    // ~/Library/Logs/Lilypad, which is what "Copy for support" describes and
    // what the copy below promises. The webview console does NOT reach that
    // file on its own — this app installs `env_logger` directly rather than
    // `tauri-plugin-log`, so nothing forwards it.
    console.error(`[lilypad::ui] ${this.props.where} failed to render:`, error);
    void invoke('log_ui_error', { windowLabel: this.props.where, message: detail }).catch(() => {
      /* Outside Tauri, or the backend is already gone. The screen below is
         still correct and still tells the customer what to do. */
    });
  }

  override render(): React.ReactNode {
    if (this.state.message === null) return this.props.children;

    return (
      <div className="page error-page" role="alert" data-testid="render-error">
        <h1>Lilypad hit a problem</h1>
        <p className="muted">
          This window stopped working. Your Mac is fine, and any session that was running is
          unaffected: it runs outside this window.
        </p>
        {/* The message is shown rather than hidden. It is written by us, not by
            the customer's data, and a person reporting a fault does better with
            a specific string to quote than with "an error occurred". */}
        <p className="error-page__detail">{this.state.message}</p>
        <p className="muted">
          Closing and reopening this window usually clears it. If it keeps happening, open
          Diagnostics from the menu bar, press <strong>Copy for support</strong>, and send it to
          support@takedia.com. This has already been written to the log that report includes.
        </p>
      </div>
    );
  }
}
