import { createHash } from 'crypto';
import { sha256Hex } from './sha256';

const node = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it.each([55, 56, 57, 63, 64, 65, 119, 120, 128, 1000])('agrees with Node across block edges (%i bytes)', (length) => {
    const text = 'x'.repeat(length);
    expect(sha256Hex(text)).toBe(node(text));
  });

  it('hashes the UTF-8 bytes of non-ASCII text', () => {
    for (const text of ['MMRF – café', '日本語のテキスト', '\u{1F9EC} DNA', 'a\u0000b']) {
      expect(sha256Hex(text)).toBe(node(text));
    }
  });

  it('hashes a large canonical definition as Node does', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `SYNTH-CASE-${String(i).padStart(4, '0')}`);
    const text = JSON.stringify({ caseIds: ids, kind: 'case_ids', schema: 'orion.cohort-def/v1' });
    expect(sha256Hex(text)).toBe(node(text));
  });
});
