// AWS Signature Version 4, hand-rolled on Node crypto (no AWS SDK is in the lockfile). Covers what
// the BFF sends: header-signed requests with a body hash, for AgentCore (paths encoded twice in
// the canonical request) and S3 (paths encoded once, x-amz-content-sha256 required).
// Tested against AWS's published vectors and against botocore-signed requests (sigv4.unit.test.ts).

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When temporary credentials stop working; absent for long-term keys. */
  expiration?: Date;
}

export interface SignRequest {
  method: string;
  /** The URL as sent: its path already percent-encoded once (see `uriEncode`). */
  url: URL;
  /** Headers to send. Host, X-Amz-Date, X-Amz-Security-Token and Authorization are added. */
  headers: Record<string, string>;
  body: Uint8Array | string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  now: Date;
  /** S3 rules: the path is signed as sent, and x-amz-content-sha256 is added and signed. */
  s3?: boolean;
}

export interface SignedRequest {
  /** Every header to send, the input headers included. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Headers left out of the signature: hop-by-hop or rewritten in transit, and the trace headers
 * (botocore does not sign traceparent either, so a tracing proxy cannot break the signature).
 */
const UNSIGNED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'connection',
  'content-length',
  'expect',
  'keep-alive',
  'transfer-encoding',
  'user-agent',
  'x-amzn-trace-id',
  'traceparent',
  'tracestate',
  'baggage',
]);

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 defines it: everything but A–Z, a–z, 0–9, `-`, `_`, `.` and `~`. */
export const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `YYYYMMDDTHHMMSSZ`. */
export const amzDate = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export const signingKey = (secretAccessKey: string, date: string, region: string, service: string): Buffer =>
  hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');

const canonicalPath = (url: URL, s3: boolean): string => {
  const path = url.pathname || '/';
  // Every service but S3 encodes each (already encoded) segment a second time.
  return s3 ? path : path.split('/').map(uriEncode).join('/');
};

const decodeQueryPart = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

const canonicalQuery = (url: URL): string => {
  const search = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (!search) return '';
  const pairs = search
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      const key = eq === -1 ? part : part.slice(0, eq);
      const val = eq === -1 ? '' : part.slice(eq + 1);
      return [uriEncode(decodeQueryPart(key)), uriEncode(decodeQueryPart(val))] as const;
    });
  pairs.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  return pairs.map(([key, val]) => `${key}=${val}`).join('&');
};

const normalizeValue = (value: string): string => value.trim().replace(/\s+/g, ' ');

export const signRequest = (request: SignRequest): SignedRequest => {
  const { credentials, now, region, service, url } = request;
  const s3 = request.s3 ?? false;
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const payloadHash = sha256Hex(request.body);

  const headers: Record<string, string> = { ...request.headers };
  for (const name of Object.keys(headers)) {
    if (['host', 'x-amz-date', 'x-amz-security-token', 'authorization'].includes(name.toLowerCase())) {
      delete headers[name];
    }
  }
  headers.Host = url.host;
  headers['X-Amz-Date'] = stamp;
  if (credentials.sessionToken) headers['X-Amz-Security-Token'] = credentials.sessionToken;
  if (s3) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'x-amz-content-sha256') delete headers[name];
    }
    headers['X-Amz-Content-SHA256'] = payloadHash;
  }

  const signed = new Map<string, string>();
  for (const [name, val] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (UNSIGNED_HEADERS.has(lower)) continue;
    const normalized = normalizeValue(val);
    signed.set(lower, signed.has(lower) ? `${signed.get(lower)},${normalized}` : normalized);
  }
  const names = [...signed.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url, s3),
    canonicalQuery(url),
    names.map((name) => `${name}:${signed.get(name)}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(credentials.secretAccessKey, date, region, service), stringToSign).toString('hex');
  headers.Authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
};
