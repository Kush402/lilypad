import { classifyQuality } from './quality';

describe('classifyQuality', () => {
  it('is good under low RTT and negligible loss', () => {
    expect(classifyQuality(40, 0)).toBe('good');
  });

  it('is fair once RTT or loss crosses the good threshold but stays under fair', () => {
    expect(classifyQuality(150, 1)).toBe('fair');
    expect(classifyQuality(50, 3)).toBe('fair');
  });

  it('is poor once RTT or loss exceeds the fair threshold', () => {
    expect(classifyQuality(300, 0)).toBe('poor');
    expect(classifyQuality(50, 10)).toBe('poor');
  });

  it('treats missing samples as zero (good) rather than crashing', () => {
    expect(classifyQuality(null, null)).toBe('good');
  });
});
