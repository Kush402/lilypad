import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const invoke = vi.fn(async () => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

function Boom(): React.JSX.Element {
  throw new Error('display 3 is not a display');
}

/**
 * Before this existed, a thrown error unmounted the tree and React left an
 * empty document: a white dashboard, or a 108-pixel transparent hole on top of
 * everything with no way to close it. Nothing was said and nothing was written
 * down, so the "Copy for support" report a customer was then asked for
 * described an app that looked fine.
 */
describe('when a window fails to render', () => {
  beforeEach(() => {
    invoke.mockClear();
    // React prints the caught error itself; the test output is not the subject.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('gets out of the way when nothing is wrong', () => {
    render(
      <ErrorBoundary where="control">
        <p>the dashboard</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the dashboard')).toBeTruthy();
    expect(screen.queryByTestId('render-error')).toBeNull();
  });

  it('says what happened instead of showing an empty window', () => {
    render(
      <ErrorBoundary where="control">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('render-error')).toBeTruthy();
    // The specific string, not "an error occurred": someone reporting a fault
    // does better with something to quote.
    expect(screen.getByText('display 3 is not a display')).toBeTruthy();
  });

  it('says the session is unaffected, because it is', () => {
    // The session runs in Rust, outside this webview. A person watching their
    // window break has no way to know that, and assuming the worst is
    // reasonable unless told otherwise.
    render(
      <ErrorBoundary where="control">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/any session that was running is unaffected/i)).toBeTruthy();
  });

  it('writes it to the log the support report actually includes', () => {
    // The whole point. `console.error` does not reach
    // ~/Library/Logs/Lilypad — this app installs env_logger directly, and
    // nothing forwards the webview console — so without this call the screen
    // would promise a log entry that was never made.
    render(
      <ErrorBoundary where="setup">
        <Boom />
      </ErrorBoundary>,
    );
    expect(invoke).toHaveBeenCalledWith(
      'log_ui_error',
      expect.objectContaining({ windowLabel: 'setup' }),
    );
  });

  it('still renders the screen when the log call fails', () => {
    // Outside Tauri, or with the backend already gone. A boundary that throws
    // while handling an error is how a blank window comes back.
    invoke.mockRejectedValueOnce(new Error('no tauri here'));
    render(
      <ErrorBoundary where="bubble">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('render-error')).toBeTruthy();
  });
});
