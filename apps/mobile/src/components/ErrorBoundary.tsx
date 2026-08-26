import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { record } from '../lib/journal';

/**
 * The last thing between a render error and a white screen.
 *
 * Without this, a thrown error unmounts the tree and React Native leaves the
 * app blank. On a phone that reads as "the app is broken, delete it": there is
 * no window to close, no console to open, and nothing to tell anyone. The
 * desktop got the same treatment for the same reason
 * (`apps/desktop/src/components/ErrorBoundary.tsx`).
 *
 * Nothing is transmitted. The error goes to the local session journal, which is
 * what the viewer's existing "copy diagnostics for support" affordance reads,
 * so the customer decides whether any of it is shared. That is the whole shape
 * of error reporting in this product: user-reported, never collected.
 */
interface Props {
  children: React.ReactNode;
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
    record(
      'ui.render_failed',
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${
        info.componentStack ?? ''
      }`,
    );
  }

  /** Let someone back into the app without force-quitting it. A remount is not
   * a fix, but the failure is usually in one screen's state and the customer
   * should not have to swipe the app away to find that out. */
  private readonly retry = () => this.setState({ message: null });

  override render(): React.ReactNode {
    if (this.state.message === null) return this.props.children;

    return (
      <View style={styles.screen} testID="render-error">
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Lilypad hit a problem</Text>
          <Text style={styles.body}>
            The app stopped drawing this screen. Your Mac is fine, and nothing on it was changed.
          </Text>
          {/* Shown rather than hidden: it is our string, not the customer's
              data, and someone reporting a fault does better with something
              specific to quote. */}
          <Text style={styles.detail}>{this.state.message}</Text>
          <Text style={styles.body}>
            If this keeps happening, email support@takedia.com and say what you were doing.
          </Text>
          <Pressable
            testID="render-error-retry"
            style={styles.btn}
            onPress={this.retry}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 24, gap: 12, flexGrow: 1, justifyContent: 'center' },
  title: { color: theme.ink, fontSize: 20, fontWeight: '700' },
  body: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  detail: {
    color: theme.danger,
    fontSize: 12,
    fontFamily: 'Menlo',
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    padding: 10,
  },
  btn: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: theme.onAccent, fontWeight: '700', fontSize: 15 },
});
