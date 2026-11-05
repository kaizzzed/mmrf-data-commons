const ID_PATTERN = /^[0-9a-f]{32}$/;

/** Thread, run and message ids: 128 random bits as 32 lowercase hex characters. */
export const newId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value);
