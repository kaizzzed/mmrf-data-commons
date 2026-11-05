/** @jest-environment node */
import { invokeAgentRuntimeRequest, signPrepared, stopRuntimeSessionRequest } from './agentcore';
import { getObjectRequest } from './s3';
import { amzDate, sha256Hex, signingKey, signRequest, uriEncode, type AwsCredentials } from './sigv4';
import { TEST_CREDENTIALS, TEST_RUNTIME_ARN } from './testHarness';

// AWS's published example keys (aws-sig-v4-test-suite and the IAM and S3 documentation).
const SUITE: AwsCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const SUITE_DATE = new Date('2015-08-30T12:36:00Z');
const S3_DOCS: AwsCredentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

const suite = (method: string, url: string, headers: Record<string, string> = {}, body = '') =>
  signRequest({
    method,
    url: new URL(url),
    headers,
    body,
    service: 'service',
    region: 'us-east-1',
    credentials: SUITE,
    now: SUITE_DATE,
  });

const authorization = (scope: string, signedHeaders: string, signature: string, key = 'AKIDEXAMPLE') =>
  `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

describe('SigV4 against the published AWS vectors', () => {
  it('get-vanilla', () => {
    const signed = suite('GET', 'https://example.amazonaws.com/');
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    expect(signed.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n'),
    );
    expect(signed.headers.Authorization).toBe(
      authorization(
        '20150830/us-east-1/service/aws4_request',
        'host;x-amz-date',
        '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
      ),
    );
  });

  it('post-vanilla', () => {
    expect(suite('POST', 'https://example.amazonaws.com/').signature).toBe(
      '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    );
  });

  it('get-vanilla-query-order-key-case: query parameters sorted', () => {
    const signed = suite('GET', 'https://example.amazonaws.com/?Param2=value2&Param1=value1');
    expect(signed.canonicalRequest.split('\n')[2]).toBe('Param1=value1&Param2=value2');
    expect(signed.signature).toBe('b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });

  it('post-x-www-form-urlencoded: a signed content type and body hash', () => {
    const signed = suite(
      'POST',
      'https://example.amazonaws.com/',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      'Param1=value1',
    );
    expect(signed.headers.Authorization).toBe(
      authorization(
        '20150830/us-east-1/service/aws4_request',
        'content-type;host;x-amz-date',
        'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
      ),
    );
  });

  it('the IAM ListUsers example from the SigV4 documentation', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      service: 'iam',
      region: 'us-east-1',
      credentials: SUITE,
      now: SUITE_DATE,
    });
    expect(sha256Hex(signed.canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(signed.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('derives the documented signing key', () => {
    expect(signingKey(SUITE.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  it('the S3 GET Object example: path signed once, x-amz-content-sha256 added and signed', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      body: '',
      service: 's3',
      region: 'us-east-1',
      credentials: S3_DOCS,
      now: new Date('2013-05-24T00:00:00Z'),
      s3: true,
    });
    expect(signed.headers['X-Amz-Content-SHA256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(signed.canonicalRequest)).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
    expect(signed.headers.Authorization).toBe(
      authorization(
        '20130524/us-east-1/s3/aws4_request',
        'host;range;x-amz-content-sha256;x-amz-date',
        'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
        'AKIAIOSFODNN7EXAMPLE',
      ),
    );
  });
});

// Signed offline by botocore 1.43.123 (its own serializer and SigV4Auth, nothing sent), with the
// suite keys, a fake session token and 2026-11-05T12:00:00Z.
describe('SigV4 against botocore-signed requests for the calls the BFF makes', () => {
  const NOW = new Date('2026-11-05T12:00:00Z');
  const CONFIG = {
    agentCoreEndpoint: new URL('https://bedrock-agentcore.us-east-1.amazonaws.com'),
    runtimeArn: TEST_RUNTIME_ARN,
    qualifier: 'DEFAULT',
  };
  const SESSION = 'orion-0123456789abcdef0123456789abcdef';
  const BODY = Buffer.from(
    '{"threadId":"0123456789abcdef0123456789abcdef","runId":"fedcba9876543210fedcba9876543210","state":{},' +
      '"messages":[],"tools":[],"context":[],"forwardedProps":{"orion":{"action":"warmup"}}}',
  );
  const SCOPE = '20261105/us-east-1/bedrock-agentcore/aws4_request';

  it('InvokeAgentRuntime: the ARN encoded once in the URL, twice in the signature; traceparent unsigned', () => {
    const prepared = invokeAgentRuntimeRequest(CONFIG, {
      sessionId: SESSION,
      body: BODY,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(prepared.url.href).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/' +
        'arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Forion_agent-AbCdEf1234' +
        '/invocations?qualifier=DEFAULT',
    );
    const headers = signPrepared(prepared, { region: 'us-east-1', credentials: TEST_CREDENTIALS, now: NOW });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': SESSION,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      Host: 'bedrock-agentcore.us-east-1.amazonaws.com',
      'X-Amz-Date': '20261105T120000Z',
      'X-Amz-Security-Token': 'FAKE-SESSION-TOKEN-FOR-TESTS',
      Authorization: authorization(
        SCOPE,
        'accept;content-type;host;x-amz-date;x-amz-security-token;x-amzn-bedrock-agentcore-runtime-session-id',
        '600f360e9ce7e535a1b191fe63b088884a880adc05cc3c5b00e3a5b830de0a76',
      ),
    });
  });

  it('StopRuntimeSession', () => {
    const prepared = stopRuntimeSessionRequest(CONFIG, SESSION, '11111111-2222-4333-8444-555555555555');
    expect(prepared.url.pathname.endsWith('/stopruntimesession')).toBe(true);
    expect(prepared.body.toString()).toBe('{"clientToken":"11111111-2222-4333-8444-555555555555"}');
    const headers = signPrepared(prepared, { region: 'us-east-1', credentials: TEST_CREDENTIALS, now: NOW });
    expect(headers.Authorization).toBe(
      authorization(
        SCOPE,
        'content-type;host;x-amz-date;x-amz-security-token;x-amzn-bedrock-agentcore-runtime-session-id',
        '54edd9560fed6978c4ece544b776c282554aa31d19a4a19f141c2808846ee57d',
      ),
    );
  });

  it('S3 GetObject on the regional virtual-hosted endpoint', () => {
    const prepared = getObjectRequest(
      { region: 'us-east-1', bucket: 'orion-runs-example', endpoint: null },
      'orion/runs/fedcba9876543210fedcba9876543210.json',
    );
    expect(prepared.url.href).toBe(
      'https://orion-runs-example.s3.us-east-1.amazonaws.com/orion/runs/fedcba9876543210fedcba9876543210.json',
    );
    const headers = signPrepared(prepared, {
      region: 'us-east-1',
      credentials: TEST_CREDENTIALS,
      now: NOW,
      service: 's3',
      s3: true,
    });
    expect(headers['X-Amz-Content-SHA256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(headers.Authorization).toBe(
      authorization(
        '20261105/us-east-1/s3/aws4_request',
        'host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
        'ff898f555c52d4d7b2d4d6d7610aaf6adcc5bb10d72ad7423a89f67df461daee',
      ),
    );
  });

  it('header values trimmed and collapsed, repeated query keys sorted by value, paths encoded twice', () => {
    const signed = signRequest({
      method: 'POST',
      url: new URL('https://example.amazonaws.com/a%20b/c?b=2&a=1&a=0&k=%2F'),
      headers: { 'X-Custom': '  one   two  ', 'Content-Type': 'application/json' },
      body: '{"x":1}',
      service: 'service',
      region: 'us-east-1',
      credentials: TEST_CREDENTIALS,
      now: NOW,
    });
    const lines = signed.canonicalRequest.split('\n');
    expect(lines[1]).toBe('/a%2520b/c');
    expect(lines[2]).toBe('a=0&a=1&b=2&k=%2F');
    expect(lines).toContain('x-custom:one two');
    expect(signed.signature).toBe('45b32a38fec12ae16e593038c466e0e9c461359748d031e857a9d5f9a6d57769');
  });
});

describe('SigV4 helpers', () => {
  it('encodes everything but the unreserved characters', () => {
    expect(uriEncode("a-b_c.d~e f!'()*:/")).toBe('a-b_c.d~e%20f%21%27%28%29%2A%3A%2F');
  });

  it('formats the request time', () => {
    expect(amzDate(new Date('2026-11-05T01:02:03.456Z'))).toBe('20261105T010203Z');
  });

  it('replaces caller-supplied auth headers instead of signing them', () => {
    const signed = suite('GET', 'https://example.amazonaws.com/', {
      authorization: 'stale',
      'x-amz-date': '19700101T000000Z',
      host: 'elsewhere.example',
    });
    expect(signed.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(Object.keys(signed.headers).filter((name) => name.toLowerCase() === 'authorization')).toHaveLength(1);
  });
});
