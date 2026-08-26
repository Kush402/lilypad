import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ErrorBoundary } from './ErrorBoundary';
import { journalText, startSession } from '../lib/journal';

function Boom(): React.JSX.Element {
  throw new Error('the session ended while the screen was drawing');
}

/**
 * Without a boundary, a thrown error unmounts the tree and React Native leaves
 * the app blank. On a phone that reads as "this is broken, delete it": there is
 * no window to close, no console to open, and nothing to tell anyone.
 */
describe('when the phone fails to render a screen', () => {
  beforeEach(() => {
    startSession();
    // React prints the caught error itself; the test output is not the subject.
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('gets out of the way when nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <Text>your laptops</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText('your laptops')).toBeTruthy();
    expect(screen.queryByTestId('render-error')).toBeNull();
  });

  it('says what happened rather than going white', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('render-error')).toBeTruthy();
    // The specific message, not "something went wrong": a person reporting a
    // fault does better with something to quote.
    expect(screen.getByText('the session ended while the screen was drawing')).toBeTruthy();
  });

  it('says the Mac is untouched, because it is', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Your Mac is fine/i)).toBeTruthy();
  });

  it('writes it to the journal the support copy already reads', () => {
    // User-reported, never collected. This only puts the failure where the
    // viewer's existing "copy diagnostics" affordance can find it; whether it
    // goes anywhere is the customer's decision, as it already was.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(journalText()).toMatch(/ui\.render_failed/);
  });

  it('offers a way back in that is not force-quitting', () => {
    // A child that fails once and then works: the transient case retry exists
    // for. Retrying a screen that is deterministically broken lands back on
    // this same message, which is honest and is what should happen.
    let thrown = false;
    function FailsOnce(): React.JSX.Element {
      if (!thrown) {
        thrown = true;
        throw new Error('a race on first mount');
      }
      return <Text>your laptops</Text>;
    }

    render(
      <ErrorBoundary>
        <FailsOnce />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('render-error')).toBeTruthy();

    fireEvent.press(screen.getByTestId('render-error-retry'));

    expect(screen.getByText('your laptops')).toBeTruthy();
    expect(screen.queryByTestId('render-error')).toBeNull();
  });
});
