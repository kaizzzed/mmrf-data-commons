import { isId, newId } from './ids';

describe('newId', () => {
  it('returns 32 lowercase hex characters from 16 random bytes', () => {
    const spy = jest.spyOn(globalThis.crypto, 'getRandomValues');
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isId(id)).toBe(true);
    const [bytes] = spy.mock.calls[0];
    expect(bytes).toHaveLength(16);
    spy.mockRestore();
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
  });

  it('rejects anything but 32 lowercase hex characters', () => {
    expect(isId('A'.repeat(32))).toBe(false);
    expect(isId('a'.repeat(31))).toBe(false);
    expect(isId(42)).toBe(false);
  });
});
