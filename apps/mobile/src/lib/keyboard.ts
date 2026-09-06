import { splitGraphemes } from 'unicode-segmenter/grapheme';

/** Edits at the remote caret. Native keyPress and changeText describe the
 * same deletion: only changeText owns edits while the local buffer has text.
 * Keep this buffer for as long as the native input keeps its value, including
 * blur/focus. Reset BOTH when another control changes the remote caret. */
export class KeyboardComposer {
  private text = '';

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  reset(): void {
    this.text = '';
  }

  change(next: string): { backspaces: number; text: string } {
    if (next === this.text) return { backspaces: 0, text: '' };
    const before = [...splitGraphemes(this.text)];
    const after = [...splitGraphemes(next)];
    let common = 0;
    while (common < before.length && before[common] === after[common]) common++;
    this.text = next;
    // Rewrite the changed suffix, including IME/correction replacements.
    // Backspace deletes graphemes, not UTF-16 halves or emoji components.
    return { backspaces: before.length - common, text: after.slice(common).join('') };
  }
}
