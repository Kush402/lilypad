---
status: Implemented
owner: @kushsharma024
last-verified: 2026-09-22
summary: How Ask sees, points, clicks and types on the Mac with any provider — instant actions, the toolset, the flow of one step, the safety floor, takeover, and where each part lives.
---

# Ask computer use

Ask completes a task on the Mac the way a person would: it looks at the
screen, acts with the mouse and keyboard, and looks again to confirm. It works
with every provider Lilypad supports. The decision and its limits are in
[ADR-0018](adr/0018-ask-operates-the-mac-under-full-control.md); this page is
how it works.

## One step

1. **Look.** Every run starts with a look before the model is asked anything,
   so its first reply is about the real screen. A look is: a JPEG of the shared
   display (long edge ≤ 1366 px, ≤ 1.15 MP, the pointer drawn in), the focused
   app's actionable elements (id, role, label, value, centre), what is in front
   and what has keyboard focus. Models without a trained computer tool also
   see numbered boxes on the screenshot for those elements. If the text-only
   Jev path has no readable focused app, or Lilypad itself is in front, Jev
   may make only the command-grounded decision needed to obtain a screen:
   open one offered installed app or a web address written in the command.
   Code rejects every screen-dependent action until a real non-Lilypad reading
   exists.
2. **Decide.** The model replies with one or more tool calls. They are queued
   (at most 8 run per reply) and handed to the runner one at a time.
3. **Resolve.** The executor attaches what the action would touch: the element
   and app under a point (hit test), or what has keyboard focus.
4. **Gate.** The floor refuses what is never done; supervision holds clicks,
   drags, value changes, URLs and dangerous shortcuts for Approve on the
   phone; full control runs them — except when step 3 could not tell what
   they land on, which is asked, as under supervision, because the floor had
   nothing to check.
5. **Act.** The gesture runs on the session's input thread
   ([`input/agent_ops.rs`](../apps/desktop/src-tauri/src/input/agent_ops.rs)).
6. **Settle and look again**, but only after the last action of the reply: the
   executor waits until two looks 120 ms apart agree (150 ms minimum, 2.5 s
   cap). A failure is always shown with a fresh look.
7. **Answer.** All results go back in one turn, in call order, with one image
   at the end. After a failure every later call is answered
   `Not executed: an earlier computer action in this turn failed.`

## Instant actions

With a TypeSafe key on the Mac
([ADR-0019](adr/0019-ask-does-short-commands-instantly.md)), a command of at
most 12 words is first tried as one instant action, between the first look
and the first model request
([`llm/jev.rs`](../apps/desktop/src-tauri/src/agent/llm/jev.rs)):

- One request to TypeSafe's Jev asks what kind of action it is — press a
  listed control, open an app, open a website written in the command, scroll,
  a standard shortcut, or something else — and which one.
- It acts only when the kind is ≥ 0.75 likely, the choice ≥ 0.9 (direction
  ≥ 0.8), and the choice is one Ask offered. The action goes through the same
  resolve, gate and phone feed as any other, without a settle-and-look, and
  its success ends the run.
- Code adds its own limits on top of the model's choice. A control is pressed
  only when every meaningful command word is in its label and it is the unique
  most-specific matching control; a shortcut runs only when its description is
  the unique one the command names. A website is opened only when no
  listed control has that name (in Finder, "open notes.txt" means the file).
  A command with a negation or a condition ("don't", "if", "then", "until")
  and a command longer than 160 characters go straight to the model. Nothing
  is asked while Lilypad itself is in front.
- The model is pinned to `jev-1.13.0`, the version the thresholds were
  measured on, and an answer from any other version is ignored. A new version
  means capturing the fixtures again and changing the pin in the same change.
- Anything else goes to the model on the same first look. A declined,
  refused or failed instant action also goes to the model, with a note
  saying what happened. A valid resumed task (an answer to a question) never
  tries it; an answer whose parked conversation is missing, expired or for a
  changed destination is refused rather than becoming a fresh command.
- Sent: the command, the app in front, each listed control's role and label,
  and installed app names sharing a word with the command. Never a
  screenshot, a field's value or a window title.
- The phone is told about TypeSafe as a second destination
  (`destination.instant`, with its own consent revision), and only a command
  echoing that revision may use it.

The key is added under Ask in the Mac's settings or given as
`TYPESAFE_API_KEY` in development. Before it is kept in the keychain, Settings
sends TypeSafe one fixed question (nothing from the screen) to the pinned
model, so a stored key has already done what a run will ask of it. If
TypeSafe later refuses the key during a run, it is not sent again until the
app restarts or a key is saved, and Settings shows "Key refused".
The thresholds rest on real answers in `jev_fixtures.json`; recapture them
with `capture_real_jev_answers` when the questions change.

## Lilypad's Jev account (Pro)

Ask has two Jev paths. **Your own TypeSafe key** is available on every plan,
stays on the Mac, and goes directly to TypeSafe. **Lilypad** needs an active
Pro or Team entitlement and no customer key: the Mac authenticates
`POST /ask/v1/systemone` with its device token, and only the backend holds
`TYPESAFE_SERVICE_API_KEY`.

The backend validates the text-only System One shape, rejects screenshots and
unknown fields, checks the account's effective entitlement, and atomically
counts at most 25 task IDs per account per UTC day in Redis. Every step of one
run has the same opaque task ID, so a five-step task costs one task. The
backend stores only expiring counters; it does not store or log commands,
control labels, questions, or answers. Missing entitlement, credential, Redis,
or upstream service fails closed and never falls back to a customer's key.

Both paths use the same local Jev loop, safety floor, autonomy gate, and phone
feed. The hosted path sends the command, front app, keyboard focus, control
roles/labels, matching installed-app names, and one-line step summaries to
Lilypad and then TypeSafe. It never sends a screenshot or field value.

The whole-task loop asks one **grounded action Choice** per observation. Its
options are the concrete code-offered operations for that state: an eligible
control id, words extracted from the command for a verified focused field, a
command-named app/URL/shortcut/scroll, search submission, wait, blocked, and
done. Goal and visible-evidence Noul questions travel in the same request.
There is no preliminary `press`/`type`/`key`/`scroll` classification and no
minimum probability that discards the selected offered action: a split
distribution often means several useful controls, not that none is usable.
Code still validates the selected option, constrains text to the command,
rejects screen actions without a readable non-Lilypad app, and sends every
effect through the normal floor and autonomy gate. If an action changes no
observable state and Jev proposes it again, the loop tries the next-best
nonterminal offered option rather than repeating the known no-op.

This follows TypeSafe's documented division of responsibility—typed
probabilistic decisions inside a code-owned workflow—and the grounded loop
used by the published `jev-browser` implementation: concrete actions in one
Choice, independent goal/stuck judgments, and next-best recovery rather than
a blanket low-confidence abort. Laya exposes the same Choice/Score/Noul
contract; it is corroborating architecture, not a second model hidden in the
product. References: [TypeSafe's Jev introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[System One API](https://api.typesafe.ai/docs),
[`jev-browser`](https://github.com/jkudish/jev-browser), and
[Laya](https://github.com/NandhaKishorM/laya).

## The toolset

Every provider gets the same tools
([`llm/mod.rs`](../apps/desktop/src-tauri/src/agent/llm/mod.rs) `agent_tools`):

| Tool                                                                                      | What it does                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `screenshot`, `zoom`                                                                      | Look (vision models only); `zoom` crops at full resolution               |
| `left_click`, `double_click`, `triple_click`, `right_click`, `middle_click`, `mouse_move` | Point by `element` id or `coordinate`; `text` holds modifiers            |
| `left_click_drag`, `left_mouse_down`, `left_mouse_up`                                     | Drags; a held button is released at the latest when the run ends         |
| `scroll`                                                                                  | Moves the pointer there first — the wheel has no position of its own     |
| `type`                                                                                    | One character (grapheme) per event; `\n` presses Return, `\t` Tab        |
| `key`, `hold_key`                                                                         | xdotool names, web codes, Mac words or glyphs; letters follow the layout |
| `wait`, `cursor_position`, `read_screen`                                                  | Pause and look; where the pointer is; a text reading of the screen       |
| `set_value`, `element_action`                                                             | Accessibility: replace a field's value; `AXPress`, `AXShowMenu`, …       |
| `open_app`, `open_url`, `new_folder`, `ask_user`, `finish`                                | Skills, a question for the person, the end                               |

A model that cannot see gets the same tools without screenshots or
coordinates, and a full text reading of the window with every look.

**Anthropic** models get Anthropic's trained tool instead of the computer
members above: `computer_toolset_20260801` (current models, no beta header),
else `computer_20251124` or `computer_20250124` behind their beta headers,
else the functions. Each step down happens only when an endpoint answers 400
naming the tool, and is remembered per model for the life of the app
([`llm/anthropic.rs`](../apps/desktop/src-tauri/src/agent/llm/anthropic.rs)).
The members decode through the same decoder; a toolset call is replayed with
its `toolset_name`.

**Coordinates.** A model answers either in pixels of the screenshot or on a
0–1000 grid. Gemini, Qwen3-VL, GLM-4.xV and UI-TARS default to the grid,
everything else to pixels; the setup check measures it by asking the model to
point at a known square and stores what it saw. The engine only ever handles
normalized 0–1 points.

## The floor

Refused in every mode ([`security.rs`](../apps/desktop/src-tauri/src/agent/security.rs) `floor`):

- typing into a password field, or while macOS secure input is on;
- anything that lands on Lilypad itself, or opening Lilypad;
- the macOS password and Touch ID prompts, the login window, permission
  prompts, Keychain Access and Passwords (matched by executable path in
  [`ax/mod.rs`](../apps/desktop/src-tauri/src/agent/ax/mod.rs) `surface_of`);
- lock, log-out and restart shortcuts (⌃⌘Q, ⇧⌘Q, ⌥⇧⌘Q);
- typing into a terminal a command that deletes recursively, stops the Mac, or
  touches passwords, system settings or the network.

Secure input counts even when the focused element cannot be read: it is a
fact about the whole session. The legacy `ax_press` tool, no longer offered
but still understood, refuses a reading taken while Lilypad or one of those
prompts was in front.

A refusal is reported to the model as a result it can act on, and to the
person as a failed step naming the rule.

## Taking over

- **From the phone:** any touch or keystroke on the phone stops the run
  (unchanged).
- **At the Mac:** a pass-through event tap
  ([`input/takeover.rs`](../apps/desktop/src-tauri/src/input/takeover.rs))
  stops the run on a mouse press, key press, scroll or pointer movement over
  6 points that neither Ask nor the phone produced. Their events carry
  `kCGEventSourceUserData` tags, and the input thread marks the 200 ms around
  each of Ask's gestures. Modifier-only changes are ignored.
- **Fallback:** before every gesture the executor checks that the pointer is
  where Ask left it (4 points of drift is a takeover).
- **Stop** from the phone ends the run between the steps of a gesture: a long
  `type` stops after the character in flight, and every held key and button is
  released.

## Autonomy and questions

`agent_command.autonomy` is `"full"` or absent (supervised). The phone asks
once per Mac, after destination consent, and only for a Mac whose
`agent_ready.features` lists `full_control`. The choice is stored in the
phone's keychain and switchable from the Ask panel between tasks.

`ask_user` ends a run `needs_input`. The Mac keeps the conversation for 15
minutes; the phone sends the next message with `continues` set to that run's
id, and the Mac resumes the same thread with the answer and a fresh look. A
changed AI setup, a different run id or an expired thread starts a new task.

## Limits

- The step budget is 150 steps or 45 minutes. A run that repeats the same
  action with no visible change is told so on the third time and ended on the
  sixth.
- Screenshots use `CGDisplayCreateImage`.
- The element list comes from the focused app's windows on the shared display,
  up to 400 elements in document order; very long web pages list what comes
  first.
- `set_value` works on native fields; many web fields ignore a value set from
  outside, so the model is told to click and type there.
- No vendor-native tool for OpenAI's Responses API or Gemini's own computer
  use; both use the common toolset.
- Instant actions cover one action per command and need the person's own
  TypeSafe key. Whole-task Jev can use either that key on every plan or
  Lilypad's hosted Pro path; Jev only types words already present in the
  command. The whole-task loop offers at most 32 prioritized AX controls per
  observation, within Jev's high-cardinality Choice rather than as 32
  independent questions.

## Checking it

Unit and integration tests cover the chord parser, the gestures (including
release on stop and failure), the worker's gates, the gate matrix, the
decoder, batches, resume, both adapters' request shapes and the native-tool
step-down chain. What only a signed build can show is in
[the device gate](manual-device-test.md#ask-computer-use-gate).
