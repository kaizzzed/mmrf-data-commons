// S3 GetObject for run records (modes A and H): `s3:GetObject` on `<prefix>runs/*` is the BFF's
// only S3 permission, so a missing key may answer 403 AccessDenied instead of 404 NoSuchKey.

import type { CredentialProvider } from './credentials';
import { readBody, readSnippet, sendRequest } from './httpClient';
import { signPrepared, type PreparedRequest } from './agentcore';
import { uriEncode } from './sigv4';

export const S3_SERVICE = 's3';

export interface S3Location {
  region: string;
  bucket: string;
  /** Path-style requests on this origin when set (tests, S3-compatible stores). */
  endpoint: URL | null;
}

const encodeKey = (key: string): string => key.split('/').map(uriEncode).join('/');

/** Virtual-hosted `https://<bucket>.s3.<region>.amazonaws.com/<key>`, or path-style on an endpoint. */
export const getObjectRequest = ({ region, bucket, endpoint }: S3Location, key: string): PreparedRequest => {
  let url: URL;
  if (endpoint) {
    url = new URL(endpoint.href);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${uriEncode(bucket)}/${encodeKey(key)}`;
  } else {
    url = new URL(`https://${bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}`);
  }
  url.search = '';
  return { method: 'GET', url, headers: {}, body: Buffer.alloc(0) };
};

export type GetObjectResult =
  | { kind: 'found'; body: Buffer }
  | { kind: 'missing'; status: number; code: string }
  /** 429, 503, a timeout or no connection: the store is unavailable for now. */
  | { kind: 'unavailable'; status: number | null; reason: string }
  | { kind: 'error'; status: number; code: string };

const errorCode = (xml: string): string => /<Code>([^<]{1,100})<\/Code>/.exec(xml)?.[1] ?? '';

export const GET_OBJECT_TIMEOUT_MS = 10_000;

export const getObject = async (
  location: S3Location,
  key: string,
  credentials: CredentialProvider,
  { now = () => new Date(), maxBytes }: { now?: () => Date; maxBytes: number },
): Promise<GetObjectResult> => {
  const prepared = getObjectRequest(location, key);
  let response;
  try {
    const headers = signPrepared(prepared, {
      region: location.region,
      credentials: await credentials(),
      now: now(),
      service: S3_SERVICE,
      s3: true,
    });
    response = await sendRequest({
      url: prepared.url,
      method: 'GET',
      headers,
      headersTimeoutMs: GET_OBJECT_TIMEOUT_MS,
    });
  } catch (err) {
    return { kind: 'unavailable', status: null, reason: err instanceof Error ? err.name : 'error' };
  }
  const status = response.statusCode ?? 0;
  if (status === 200) {
    try {
      return { kind: 'found', body: await readBody(response, maxBytes) };
    } catch (err) {
      return { kind: 'error', status, code: err instanceof Error ? err.name : 'read failed' };
    }
  }
  const code = errorCode(await readSnippet(response, 4096));
  if (status === 404 || (status === 403 && code === 'AccessDenied')) return { kind: 'missing', status, code };
  if (status === 429 || status === 503) return { kind: 'unavailable', status, reason: code || `HTTP ${status}` };
  return { kind: 'error', status, code: code || `HTTP ${status}` };
};
