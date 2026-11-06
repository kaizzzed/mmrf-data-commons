import type { JsonValue } from '../agui/types';

export type PointerResult = { found: true; value: JsonValue } | { found: false };

/** RFC 6901: "/observed/groups/0/count" into a JSON document; "" is the whole document. */
export const resolvePointer = (document: JsonValue, pointer: string): PointerResult => {
  if (pointer === '') return { found: true, value: document };
  if (!pointer.startsWith('/')) return { found: false };
  let current: JsonValue = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false };
      current = current[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
};
