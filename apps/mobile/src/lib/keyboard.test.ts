import { KeyboardComposer } from './keyboard';

describe('KeyboardComposer', () => {
  it.each([
    ['hello', 'hello!', 0, '!'],
    ['hello', 'hello', 0, ''],
    ['hello', 'hell', 1, ''],
    ['teh', 'the', 2, 'he'],
    ['ni', '你', 2, '你'],
    ['a👩🏽‍💻', 'a', 1, ''],
    ['ae\u0301', 'a', 1, ''],
    ['a🇮🇳', 'a', 1, ''],
    ['abc', 'axbc', 2, 'xbc'],
  ])('translates %s → %s into one remote edit', (before, after, backspaces, text) => {
    const composer = new KeyboardComposer();
    composer.change(before);
    expect(composer.change(after)).toEqual({ backspaces, text });
  });

  it('replaces a grapheme when composition extends it instead of inserting broken pieces', () => {
    const composer = new KeyboardComposer();
    composer.change('e');
    expect(composer.change('e\u0301')).toEqual({ backspaces: 1, text: 'e\u0301' });
  });

  it('a reset starts a different remote editing context', () => {
    const composer = new KeyboardComposer();
    composer.change('old field');
    composer.reset();
    expect(composer.isEmpty).toBe(true);
    expect(composer.change('new field')).toEqual({ backspaces: 0, text: 'new field' });
  });
});
