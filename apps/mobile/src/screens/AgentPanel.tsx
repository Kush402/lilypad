import React, { useState } from 'react';
import { Keyboard, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { heldStep, type AgentFeedState, type AgentStepView } from '../lib/agentFeed';

/**
 * The "Ask" panel — command entry + the AI agent's live step feed, with an
 * approve/deny row for the one step the desktop is holding on. This is the
 * phone half of docs/m5.3-ai-executor-plan.md §6; all merge logic lives in the
 * tested `agentFeed` reducer, so this component is purely presentational.
 */
export interface AgentPanelProps {
  feed: AgentFeedState;
  /** Dispatch a natural-language task. */
  onSend: (text: string) => void;
  /** Stop the running task. */
  onStop: () => void;
  /** Answer the held step. */
  onDecide: (stepId: string, approve: boolean) => void;
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

function stateGlyph(view: AgentStepView): string {
  switch (view.state) {
    case 'held':
      return '⏸';
    case 'running':
      return '▶';
    case 'done':
      return '✓';
    case 'denied':
      return '⤫';
    case 'failed':
      return '✕';
    default:
      return '·';
  }
}

export function AgentPanel({ feed, onSend, onStop, onDecide }: AgentPanelProps): React.JSX.Element {
  const [text, setText] = useState('');
  const held = heldStep(feed);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
    // The command is dispatched — give the screen back to the step feed /
    // live stream. Without this (and `submitBehavior` below) a multiline
    // TextInput on iOS leaves the keyboard up with no way to dismiss it.
    Keyboard.dismiss();
  };

  return (
    <View style={styles.panel} testID="agent-panel">
      <View style={styles.inputRow}>
        <TextInput
          testID="agent-command-input"
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Ask your Mac to do something…"
          placeholderTextColor={theme.muted}
          editable={!feed.running}
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
        {feed.running ? (
          <Pressable testID="agent-stop" style={[styles.btn, styles.stopBtn]} onPress={onStop}>
            <Text style={styles.btnText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            testID="agent-send"
            style={[styles.btn, styles.sendBtn, !text.trim() && styles.btnDisabled]}
            onPress={submit}
            disabled={!text.trim()}
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
          <View style={styles.holdBtns}>
            <Pressable
              testID="agent-deny"
              style={[styles.btn, styles.denyBtn]}
              onPress={() => onDecide(held.stepId, false)}
            >
              <Text style={styles.btnText}>Deny</Text>
            </Pressable>
            <Pressable
              testID="agent-approve"
              style={[styles.btn, styles.approveBtn]}
              onPress={() => onDecide(held.stepId, true)}
            >
              <Text style={styles.btnText}>Approve</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent}>
        {feed.steps.length === 0 ? (
          <Text style={styles.empty}>
            {feed.running ? 'Thinking…' : 'Type a task above — the assistant acts on your Mac.'}
          </Text>
        ) : (
          feed.steps.map((s) => (
            <View key={s.stepId} style={styles.stepRow}>
              <Text style={[styles.glyph, { color: stateColor(s) }]}>{stateGlyph(s)}</Text>
              <Text style={styles.stepText} numberOfLines={2}>
                {s.summary}
              </Text>
            </View>
          ))
        )}
        {feed.outcome && !feed.running ? (
          <Text style={[styles.outcome, feed.outcome !== 'completed' && styles.outcomeBad]}>
            {feed.outcome === 'completed'
              ? 'Done.'
              : feed.outcome === 'stopped'
                ? 'Stopped.'
                : feed.outcome === 'denied'
                  ? 'Not allowed.'
                  : 'Failed.'}
          </Text>
        ) : null}
      </ScrollView>
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
  holdBtns: { flexDirection: 'row', gap: 8 },
  feed: { maxHeight: 130 },
  feedContent: { gap: 6, paddingVertical: 2 },
  empty: { color: theme.muted, fontSize: 13, fontStyle: 'italic' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  glyph: { fontSize: 14, width: 16, textAlign: 'center' },
  stepText: { color: theme.ink, fontSize: 13, flex: 1 },
  outcome: { color: theme.accent, fontWeight: '700', fontSize: 13, marginTop: 4 },
  outcomeBad: { color: theme.danger },
});
