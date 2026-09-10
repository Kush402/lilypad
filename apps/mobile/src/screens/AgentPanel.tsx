import React, { useEffect, useMemo, useState } from 'react';
import { Keyboard, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { heldStep, type AgentFeedState, type AgentStepView } from '../lib/agentFeed';
import { CheckGlyph, CrossGlyph, IdleGlyph, PauseGlyph, RunningGlyph } from '../components/Glyph';
import {
  grantAiConsent,
  hasAiConsent,
  hasUnresolvedRevocation,
  retryRevocation,
  revokeAiConsent,
  targetFor,
} from '../lib/aiConsent';
import type { AgentDestination, AgentHandshakeState } from '@lilypad/protocol';

/**
 * The "Ask" panel — command entry + the AI agent's live step feed, with an
 * approve/deny row for the one step the desktop is holding on. This is the
 * phone half of docs/m5.3-ai-executor-plan.md §6; all merge logic lives in the
 * tested `agentFeed` reducer, so this component is purely presentational.
 */
export interface AgentPanelProps {
  feed: AgentFeedState;
  /** Dispatch a natural-language task. */
  onSend: (text: string) => boolean | void;
  /** Stop the running task. */
  onStop: () => void;
  /** Answer the held step. */
  onDecide: (stepId: string, approve: boolean) => void;
  /** Text of a command that never left the device, restored into the box so
   * the person does not lose what they typed (L-233). */
  unsentCommand?: string | null;
  /**
   * What the Mac last said about the Ask handshake (L-285).
   *
   * `waiting` and `incompatible` are this phone's own conclusions: nothing has
   * come back yet, and the Mac answered in a protocol this phone does not
   * speak. Everything else is stated by the Mac.
   */
  handshake?: HandshakeView;
  onCheckCompatibility?: () => void;
  /** Which Mac this session is with — the phone's own pairing record. */
  desktopDeviceId?: string | null;
  /** Where that Mac says Ask observations go. `undefined` means it did not
   * say, which is a state of its own: not a reason to reuse an older
   * agreement (L-265). */
  destination?: AgentDestination;
}

/**
 * The sentence that tells the customer where their screen goes.
 *
 * The old copy named "Anthropic or OpenAI" in fixed text while the Mac would
 * accept any endpoint. Whatever this returns comes from what the Mac actually
 * disclosed this session.
 */
export function destinationSentence(destination: AgentDestination | undefined): string {
  if (!destination) {
    return 'This Mac has not said which AI provider it would send your screen to. Set one up on the Mac, then check again.';
  }
  const model = destination.model ? ` (${destination.model})` : '';
  if (destination.local) {
    return `This Mac runs its model locally at ${destination.origin}${model}. Your screen is read on the Mac and does not leave it.`;
  }
  return `This Mac sends to ${destination.providerName} at ${destination.origin}${model}. Your screen leaves your Mac and your phone for that provider. Lilypad never sees it.`;
}

/** What the Mac last said about the Ask handshake, plus the two conclusions
 * the phone draws for itself (L-285). */
export type HandshakeView = AgentHandshakeState | 'incompatible' | 'waiting';

/**
 * The one honest sentence for each handshake state (L-285).
 *
 * All of these used to be a missing `destination`, and a missing destination
 * rendered as the consent card with Allow disabled: a card asking permission
 * to send to a provider it could not name, with no way on and nothing saying
 * why. Closing and reopening Ask was the workaround, and nothing said that
 * either.
 */
export function handshakeSentence(state: HandshakeView): string {
  switch (state) {
    case 'waiting':
      return 'Checking with your Mac\u2026';
    case 'checking':
      return 'Your Mac is still working out which AI provider it would use. This usually takes a moment.';
    case 'unconfigured':
      return 'This Mac has no AI provider set up yet. Set one up on the Mac, then check again. Manual control still works.';
    case 'unavailable':
      return 'Your Mac could not read its saved AI settings. If a permission box is waiting on the Mac, allow it, then check again. Manual control still works.';
    case 'incompatible':
    default:
      return 'Ask needs compatible versions on your phone and Mac. Connect and update both apps, then check again. Manual control is still available.';
  }
}

/** The one honest sentence for each transport state (L-233). */
export function phaseLabel(phase: AgentFeedState['phase']): string | null {
  switch (phase) {
    case 'sending':
      return 'Sending\u2026';
    case 'running':
      return null; // the step feed already says what is happening
    case 'stopping':
      return 'Stopping\u2026';
    case 'unknown':
      return 'Your Mac has not confirmed this task. It may still be running. You can request Stop.';
    case 'stop_unconfirmed':
      return 'Stop is not confirmed. The task may still be running. Retry Stop or end the session.';
    case 'unsent':
      return 'Not sent \u2014 your Mac did not receive this. Try again when reconnected.';
    default:
      return null;
  }
}

/**
 * What VoiceOver reads out on the Approve/Deny buttons.
 *
 * "Approve" alone is a consent prompt with the subject removed, and the
 * summary alone omits the grants that distinguish two otherwise identical
 * scripts. A screen-reader user has to be able to hear the same difference a
 * sighted user can see (L-229).
 */
export function describeForScreenReader(view: AgentStepView): string {
  const parts = [view.approval?.purpose || view.summary];
  const a = view.approval;
  if (a) {
    if (a.target?.label) parts.push(`control ${a.target.label}`);
    parts.push(a.network ? 'network allowed' : 'network blocked');
    parts.push(
      a.writablePaths.length > 0
        ? `can write to ${a.writablePaths.join(', ')}`
        : 'can write to its scratch folder only',
    );
    parts.push(readsLabel(a.readablePaths));
    if (a.script) parts.push(`${a.script.language} script of ${a.script.source.length} characters`);
  }
  return parts.join('. ');
}

/**
 * What the card says about reading — including when the desktop did not say.
 *
 * `readablePaths` is optional on the wire because an older desktop has no such
 * field. Absent is not "nothing": that desktop grants a script broad read
 * access to the user's files, which is the opposite of what an empty list
 * means. Rendering the two the same way would be the exact defect this list
 * exists to fix, so they are worded differently.
 */
export function readsLabel(readablePaths: string[] | undefined): string {
  if (readablePaths === undefined) return 'reads not disclosed by this Mac';
  if (readablePaths.length === 0) return 'reads none of your files';
  return `can read ${readablePaths.join(', ')}`;
}

function stateColor(view: AgentStepView): string {
  if (view.toolClass === 'forbidden') return theme.danger;
  switch (view.state) {
    case 'held':
      return theme.pending; // amber — awaiting the human
    case 'running':
      return theme.accent;
    case 'done':
      return theme.muted;
    case 'denied':
    case 'failed':
      return theme.danger;
    default:
      return theme.muted;
  }
}

/**
 * Drawn, not dingbats. These were '⏸', '▶', '✓', '⤫', '✕' and '·': six glyphs
 * from whichever font the OS picked, in that font's own weight, on a feed whose
 * every other pixel comes from design tokens. VoiceOver read them out by their
 * Unicode names, which described none of these states.
 */
function StateGlyph({ view, color }: { view: AgentStepView; color: string }) {
  switch (view.state) {
    case 'held':
      return <PauseGlyph color={color} />;
    case 'running':
      return <RunningGlyph color={color} />;
    case 'done':
      return <CheckGlyph color={color} />;
    case 'denied':
    case 'failed':
      return <CrossGlyph color={color} />;
    default:
      return <IdleGlyph color={color} />;
  }
}

export function AgentPanel({
  feed,
  onSend,
  onStop,
  onDecide,
  unsentCommand,
  handshake = 'ready',
  onCheckCompatibility,
  desktopDeviceId,
  destination,
}: AgentPanelProps): React.JSX.Element | null {
  const [text, setText] = useState('');
  const held = heldStep(feed);
  const status = phaseLabel(feed.phase);
  // Something may be happening on the Mac in any of these, so Stop stays
  // reachable throughout — a command that is still `sending` used to have no
  // Stop at all, and a `stopping` one lost it the moment it was pressed.
  const inFlight = ['sending', 'running', 'stopping', 'unknown', 'stop_unconfirmed'].includes(
    feed.phase,
  );

  // A command that never left is given back to the person who typed it,
  // rather than vanishing into a feed that claims to be running (L-233).
  useEffect(() => {
    if (unsentCommand) setText(unsentCommand);
  }, [unsentCommand]);

  /* `null` is "we have not asked the keychain yet", which is neither yes nor
   * no. Rendering nothing for that beat is the same thing the desktop's Setup
   * window does while it decides which mode it is in, and it avoids showing a
   * consent card to somebody who agreed weeks ago. */
  const [consented, setConsented] = useState<boolean | null>(null);
  const [revocationStuck, setRevocationStuck] = useState(false);
  /* The consent question is about a destination, so the answer is re-read
   * whenever the destination changes. A Mac that switched provider between
   * sessions gets asked again rather than inheriting the old yes (L-265). */
  /* Memoized so its identity is stable: an effect that depends on a freshly
   * built object would re-read the keychain on every render. */
  const target = useMemo(
    () => targetFor(desktopDeviceId ?? '', destination),
    [desktopDeviceId, destination],
  );
  useEffect(() => {
    let alive = true;
    setConsented(null);
    void hasAiConsent(target)
      .then((v) => {
        if (!alive) return;
        setConsented(v);
        setRevocationStuck(hasUnresolvedRevocation());
      })
      /* Fail CLOSED. `hasAiConsent` swallows its own keychain errors, so this
       * is unreachable through it — but the alternative to catching here is a
       * panel that renders nothing forever, and the alternative to failing
       * closed is sending a screen to a third party because a phone was
       * locked. */
      .catch(() => {
        if (alive) setConsented(false);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  const submit = () => {
    const t = text.trim();
    if (!t || inFlight || !consented || handshake !== 'ready') return;
    if (onSend(t) === false) return;
    setText('');
    // The command is dispatched — give the screen back to the step feed /
    // live stream. Without this (and `submitBehavior` below) a multiline
    // TextInput on iOS leaves the keyboard up with no way to dismiss it.
    Keyboard.dismiss();
  };

  /* Before consent, deliberately (L-285). A question about where a screen
   * goes cannot be asked while the Mac has not said where that is, and the
   * action that fixes it must not be rendered behind the card it unblocks. */
  if (handshake !== 'ready') {
    return (
      <View style={styles.panel} testID="agent-handshake">
        <View testID="agent-compatibility">
          <Text accessibilityLiveRegion="polite" testID="agent-handshake-message">
            {handshakeSentence(handshake)}
          </Text>
          <Pressable
            testID="agent-handshake-recheck"
            onPress={onCheckCompatibility}
            accessibilityRole="button"
            accessibilityLabel="Check Ask compatibility"
          >
            <Text>Check again</Text>
          </Pressable>
        </View>
        {/* Something may still be running on the Mac. Whatever the handshake
         * says now, Stop stays reachable — losing it behind a status card is
         * the same defect as losing it behind a consent card. */}
        {inFlight ? (
          <View testID="agent-handshake-inflight">
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite">
              A task may still be running on your Mac.{status ? ` ${status}` : ''}
            </Text>
            <Pressable
              testID="agent-handshake-stop"
              onPress={onStop}
              disabled={feed.phase === 'stopping'}
              accessibilityRole="button"
              accessibilityLabel="Stop the current task"
              accessibilityState={{ disabled: feed.phase === 'stopping' }}
            >
              <Text>{feed.phase === 'stopping' ? 'Stopping\u2026' : 'Stop'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  if (consented === null) return null;

  /* Guideline 5.1.2(i): explicit permission BEFORE data reaches a third-party
   * model, not a line in a policy afterwards. Declining leaves every other
   * part of Lilypad working — the session, the screen, the trackpad — which
   * is what makes this a choice rather than a toll gate. */
  if (!consented) {
    return (
      <View style={styles.panel} testID="agent-consent">
        <Text style={styles.consentTitle}>
          {destination?.local
            ? 'Ask reads your screen on this Mac'
            : 'Ask sends your screen to an AI model'}
        </Text>
        <Text style={styles.consentBody} testID="agent-consent-destination">
          {destinationSentence(destination)}
        </Text>
        <Text style={styles.consentBody}>
          What it reads is what is on the shared screen: window titles and any visible text.
        </Text>
        <Text style={styles.consentBody}>
          Nothing else in Lilypad does this. A normal session streams only between this phone and
          your Mac.
        </Text>
        {revocationStuck ? (
          <View testID="agent-consent-revocation-stuck">
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite">
              Your last withdrawal could not be saved on this phone. Sharing is blocked while
              Lilypad is open, but it may not stay blocked after a restart.
            </Text>
            <Pressable
              testID="agent-consent-revocation-retry"
              onPress={() => {
                void retryRevocation().then((ok) => setRevocationStuck(!ok));
              }}
              accessibilityRole="button"
              accessibilityLabel="Try saving the withdrawal again"
            >
              <Text>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        {inFlight ? (
          <View testID="agent-withdrawal-pending">
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite">
              AI sharing is disabled for new tasks. The current task has not confirmed stopping.
              {status ? ` ${status}` : ''}
            </Text>
            <Pressable
              testID="agent-withdrawal-stop"
              onPress={onStop}
              disabled={feed.phase === 'stopping'}
              accessibilityRole="button"
              accessibilityLabel="Retry stopping the current task"
              accessibilityState={{ disabled: feed.phase === 'stopping' }}
            >
              <Text>{feed.phase === 'stopping' ? 'Stopping…' : 'Retry Stop'}</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.holdBtns}>
          <Pressable
            testID="agent-consent-decline"
            style={[styles.btn, styles.declineBtn]}
            onPress={() =>
              void revokeAiConsent(target).then((durable) => {
                setConsented(false);
                setRevocationStuck(!durable);
              })
            }
            accessibilityRole="button"
            accessibilityLabel="Not now. Do not send my screen to an AI model"
          >
            <Text style={styles.declineText}>Not now</Text>
          </Pressable>
          <Pressable
            testID="agent-consent-allow"
            style={[styles.btn, styles.approveBtn]}
            disabled={inFlight || !target}
            accessibilityState={{ disabled: inFlight || !target }}
            onPress={() => {
              // No target means the Mac did not disclose a destination. There
              // is nothing to agree to, so there is nothing to record.
              if (!inFlight && target) void grantAiConsent(target).then(() => setConsented(true));
            }}
            accessibilityRole="button"
            accessibilityLabel="Allow Lilypad to send my screen to an AI model"
          >
            <Text style={styles.btnText}>Allow</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.panel} testID="agent-panel">
      <View style={styles.inputRow}>
        <TextInput
          testID="agent-command-input"
          style={styles.input}
          accessibilityLabel="Ask your Mac to do something"

          value={text}
          onChangeText={setText}
          placeholder="Ask your Mac to do something…"
          placeholderTextColor={theme.muted}
          editable={!inFlight}
          onSubmitEditing={submit}
          returnKeyType="send"
          // On iOS a multiline TextInput turns Return into a newline key and
          // ignores returnKeyType/onSubmitEditing entirely — the keyboard
          // becomes undismissable. blurAndSubmit restores Return-to-send
          // (tasks are one-liners; there's no need for literal newlines).
          submitBehavior="blurAndSubmit"
          autoCapitalize="sentences"
          multiline
        />
        {inFlight ? (
          <Pressable
            testID="agent-stop"
            style={[styles.btn, styles.stopBtn, feed.phase === 'stopping' && styles.btnDisabled]}
            onPress={onStop}
            disabled={feed.phase === 'stopping'}
            accessibilityRole="button"
            accessibilityLabel={feed.phase === 'stopping' ? 'Stopping' : 'Stop'}
            accessibilityHint={
              feed.phase === 'stopping'
                ? 'Waiting for your Mac to confirm it stopped'
                : 'Stops what Lilypad is doing on your Mac'
            }
          >
            <Text style={styles.btnText}>
              {feed.phase === 'stopping' ? 'Stopping\u2026' : 'Stop'}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            testID="agent-send"
            style={[styles.btn, styles.sendBtn, !text.trim() && styles.btnDisabled]}
            onPress={submit}
            disabled={!text.trim()}
            accessibilityRole="button"
            accessibilityLabel="Ask"
            accessibilityState={{ disabled: !text.trim() }}
          >
            <Text style={styles.btnText}>Ask</Text>
          </Pressable>
        )}
      </View>

      {held ? (
        <View style={styles.holdCard} testID="agent-hold">
          <Text style={styles.holdTitle}>Allow this action?</Text>
          <Text style={styles.holdSummary}>{held.summary}</Text>
          {/* Why this is being asked at all.
           *
           * Only `Consequential` actions are ever held — `security.rs` runs
           * everything the model proposes through a deterministic gate, lets
           * `Safe` and `Sensitive` through, hard-refuses `Forbidden` without
           * offering it, and defaults anything it cannot positively recognise
           * to `Consequential`. So every card a person sees here is one the Mac
           * declined to do on its own.
           *
           * Saying so is the difference between a decision and a habit. The
           * card used to be a summary and two buttons, which trains a customer
           * to tap Approve — and the summary is written by a model, so it is
           * the least trustworthy thing on screen. */}
          <Text style={styles.holdWhy}>
            Your Mac won’t do this on its own. Lilypad asks before anything it can’t confirm is
            routine.
          </Text>
          {/* What is actually being granted (L-229).
           *
           * "Run shell script" is the same sentence for a script that lists a
           * folder and one that uploads it, so the summary above cannot carry
           * this decision. The grants below come from the very action the Mac
           * will run, not from the model's description of it. */}
          {held.approval ? (
            <View style={styles.grants} testID="agent-approval">
              {held.approval.target ? (
                <Text style={styles.grantLine}>
                  Control:{' '}
                  <Text style={styles.grantValue}>
                    {held.approval.target.label || '(unlabelled)'}
                  </Text>
                  {`  ·  ${held.approval.target.role}`}
                </Text>
              ) : null}
              <Text style={styles.grantLine}>
                Network:{' '}
                <Text style={held.approval.network ? styles.grantDanger : styles.grantValue}>
                  {held.approval.network ? 'allowed' : 'blocked'}
                </Text>
              </Text>
              <Text style={styles.grantLine}>
                Can write to:{' '}
                <Text
                  style={
                    held.approval.writablePaths.length > 0 ? styles.grantDanger : styles.grantValue
                  }
                >
                  {held.approval.writablePaths.length > 0
                    ? held.approval.writablePaths.join(', ')
                    : 'its scratch folder only'}
                </Text>
              </Text>
              <Text style={styles.grantLine}>
                Can read:{' '}
                <Text
                  style={
                    held.approval.readablePaths === undefined ||
                    held.approval.readablePaths.length > 0
                      ? styles.grantDanger
                      : styles.grantValue
                  }
                >
                  {held.approval.readablePaths === undefined
                    ? 'not disclosed by this Mac'
                    : held.approval.readablePaths.length > 0
                      ? held.approval.readablePaths.join(', ')
                      : 'none of your files'}
                </Text>
              </Text>
              {held.approval.script ? (
                <View style={styles.scriptBox}>
                  <Text style={styles.grantLine}>{held.approval.script.language}</Text>
                  <ScrollView
                    style={styles.scriptScroll}
                    testID="agent-approval-script"
                    accessible
                    accessibilityLabel={`Script that will run: ${held.approval.script.source}`}
                  >
                    <Text style={styles.scriptText}>{held.approval.script.source}</Text>
                  </ScrollView>
                </View>
              ) : null}
            </View>
          ) : null}
          <View style={styles.holdBtns}>
            <Pressable
              testID="agent-deny"
              style={[styles.btn, styles.denyBtn]}
              onPress={() => onDecide(held.stepId, false)}
              accessibilityRole="button"
              // This pair is a security decision about a specific action on the
              // user's Mac, and the action is `held.summary` — on screen above
              // the buttons, and nowhere in what a screen reader hears when it
              // reaches them. "Approve" alone is a consent prompt with the
              // subject removed.
              accessibilityLabel={`Deny: ${describeForScreenReader(held)}`}
            >
              <Text style={styles.btnText}>Deny</Text>
            </Pressable>
            <Pressable
              testID="agent-approve"
              style={[styles.btn, styles.approveBtn]}
              onPress={() => onDecide(held.stepId, true)}
              accessibilityRole="button"
              accessibilityLabel={`Allow: ${describeForScreenReader(held)}`}
            >
              <Text style={styles.btnText}>Approve</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent}>
        {feed.steps.length === 0 ? (
          <Text style={styles.empty}>
            {feed.running
              ? 'Thinking…'
              : inFlight
                ? 'Waiting for your Mac…'
                : 'Type a task above. The assistant acts on your Mac.'}
          </Text>
        ) : (
          feed.steps.map((s) => (
            <View key={s.stepId} style={styles.stepRow}>
              <View style={styles.glyph}>
                <StateGlyph view={s} color={stateColor(s)} />
              </View>
              <Text style={styles.stepText} numberOfLines={2}>
                {s.summary}
              </Text>
            </View>
          ))
        )}
        {/* Transport truth first: while sending, stopping, or after a frame
         * that never left, there is no outcome to report and saying one would
         * be a guess (L-233). */}
        {status ? (
          <Text
            testID="agent-phase"
            style={[styles.outcome, feed.phase === 'unsent' && styles.outcomeBad]}
            accessibilityLiveRegion="polite"
          >
            {status}
          </Text>
        ) : null}
        {feed.outcome && feed.phase === 'ended' ? (
          <Text style={[styles.outcome, feed.outcome !== 'completed' && styles.outcomeBad]}>
            {feed.outcome === 'completed'
              ? 'Done.'
              : feed.outcome === 'stopped'
                ? 'Stopped.'
                : feed.outcome === 'denied'
                  ? 'Not allowed.'
                  : feed.outcome === 'needs_input'
                    ? 'Needs your input.'
                    : 'Failed.'}
          </Text>
        ) : null}
      </ScrollView>

      {/* Consent that cannot be taken back is not consent, and a customer who
          changes their mind should not have to delete the app to act on it.
          Here rather than in a settings screen because this is the only place
          the feature exists, so it is the only place someone looks for it. */}
      <Pressable
        testID="agent-consent-withdraw"
        // Turning sharing off has to stop the thing that is sharing (L-232).
        // Revoking phone-local consent and hiding the panel left the desktop
        // run taking observations and issuing provider requests while the UI
        // said sharing was off — and hid the Stop button that could have
        // ended it. The desktop is the authoritative boundary, so the stop
        // goes out first; its `stopping` state stays visible until the Mac
        // confirms. Nothing here can recall what was already sent, and the
        // wording does not pretend otherwise.
        onPress={() => {
          if (inFlight) onStop();
          void revokeAiConsent(target).then((durable) => {
            setConsented(false);
            setRevocationStuck(!durable);
          });
        }}
        accessibilityRole="button"
        accessibilityLabel="Stop the running task and stop sending my screen to an AI model"
      >
        <Text style={styles.withdraw}>Ask sends your screen to an AI provider. Turn off</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: theme.panel,
    borderTopWidth: 1,
    borderColor: theme.line,
    padding: 10,
    gap: 8,
    maxHeight: 260,
  },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 96,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    color: theme.ink,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
  },
  btn: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: theme.onAccent, fontWeight: '700', fontSize: 14 },
  btnDisabled: { opacity: 0.4 },
  sendBtn: { backgroundColor: theme.accent },
  stopBtn: { backgroundColor: theme.danger },
  approveBtn: { backgroundColor: theme.accent, flex: 1 },
  denyBtn: { backgroundColor: theme.danger, flex: 1 },
  holdCard: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.pending,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  holdTitle: { color: theme.pending, fontWeight: '700', fontSize: 14 },
  holdSummary: { color: theme.ink, fontSize: 14 },
  holdWhy: { color: theme.muted, fontSize: 13, marginTop: 6 },
  grants: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
    gap: 3,
  },
  grantLine: { color: theme.muted, fontSize: 12 },
  grantValue: { color: theme.ink },
  grantDanger: { color: theme.danger },
  scriptBox: { marginTop: 8 },
  scriptScroll: { maxHeight: 132, backgroundColor: theme.bg, borderRadius: 6, padding: 8 },
  scriptText: { color: theme.ink, fontSize: 11, fontFamily: 'Menlo' },
  holdBtns: { flexDirection: 'row', gap: 8 },
  consentTitle: { color: theme.ink, fontWeight: '700', fontSize: 15 },
  consentBody: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  declineBtn: { backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.line, flex: 1 },
  declineText: { color: theme.ink, fontWeight: '700', fontSize: 14 },
  withdraw: { color: theme.muted, fontSize: 11, textDecorationLine: 'underline' },
  feed: { maxHeight: 130 },
  feedContent: { gap: 6, paddingVertical: 2 },
  empty: { color: theme.muted, fontSize: 13, fontStyle: 'italic' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  glyph: { width: 16, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: theme.ink, fontSize: 13, flex: 1 },
  outcome: { color: theme.accent, fontWeight: '700', fontSize: 13, marginTop: 4 },
  outcomeBad: { color: theme.danger },
});
