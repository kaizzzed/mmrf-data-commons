/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  containerCredentialProvider,
  containerSource,
  CredentialsError,
  defaultCredentialProvider,
  envCredentials,
  REFRESH_MARGIN_MS,
} from './credentials';
import { answer, startFake, type Fake } from './testHarness';

// Placeholder values in the shape the endpoint returns; nothing here is a real credential.
const issued = (n: number, expiration: string) => ({
  AccessKeyId: `ASIAFAKE${n}`,
  SecretAccessKey: `fake-secret-${n}`,
  Token: `fake-token-${n}`,
  Expiration: expiration,
  AccountId: '123456789012',
});

let fake: Fake;
let dir: string;
beforeEach(async () => {
  fake = await startFake();
  dir = mkdtempSync(path.join(tmpdir(), 'orion-creds-'));
});
afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('environment keys', () => {
  it('reads the key pair and the optional session token', () => {
    expect(envCredentials({ AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 's' })).toEqual({
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 's',
    });
    expect(
      envCredentials({ AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' }),
    ).toEqual({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's', sessionToken: 't' });
  });

  it('needs both keys', () => {
    expect(envCredentials({ AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE' })).toBeNull();
    expect(envCredentials({ AWS_SECRET_ACCESS_KEY: 's', AWS_ACCESS_KEY_ID: ' ' })).toBeNull();
  });
});

describe('the container credential endpoint (EKS Pod Identity)', () => {
  it('sends the token file as Authorization, reading it again on each refresh', async () => {
    const tokenFile = path.join(dir, 'eks-pod-identity-token');
    writeFileSync(tokenFile, 'pod-token-1\n');
    let now = Date.parse('2026-11-05T12:00:00Z');
    fake.enqueue(answer(200, issued(1, '2026-11-05T13:00:00Z')));
    fake.enqueue(answer(200, issued(2, '2026-11-05T14:00:00Z')));
    const source = containerSource({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${fake.url}/v1/credentials`,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile,
    });
    if (!source) throw new Error('no container source');
    const provider = containerCredentialProvider(source, () => now);

    const first = await provider();
    expect(first).toEqual({
      accessKeyId: 'ASIAFAKE1',
      secretAccessKey: 'fake-secret-1',
      sessionToken: 'fake-token-1',
      expiration: new Date('2026-11-05T13:00:00Z'),
    });
    expect(fake.requests[0].method).toBe('GET');
    expect(fake.requests[0].url).toBe('/v1/credentials');
    expect(fake.requests[0].headers.authorization).toBe('pod-token-1');

    // Cached until five minutes before expiry.
    now = Date.parse('2026-11-05T13:00:00Z') - REFRESH_MARGIN_MS - 1;
    expect(await provider()).toBe(first);
    expect(fake.requests).toHaveLength(1);

    writeFileSync(tokenFile, 'pod-token-2');
    now += 2;
    expect((await provider()).accessKeyId).toBe('ASIAFAKE2');
    expect(fake.requests[1].headers.authorization).toBe('pod-token-2');
  });

  it('shares one fetch between concurrent callers', async () => {
    fake.enqueue(answer(200, issued(1, '2099-01-01T00:00:00Z')));
    const provider = containerCredentialProvider({ url: new URL(`${fake.url}/creds`) });
    const [a, b] = await Promise.all([provider(), provider()]);
    expect(a).toBe(b);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].headers.authorization).toBeUndefined();
  });

  it.each([
    ['an error status', answer(500, { message: 'no' })],
    ['a body without keys', answer(200, { AccessKeyId: 'x' })],
    ['a bad expiration', answer(200, { ...issued(1, 'soon') })],
  ])('rejects %s with CredentialsError', async (_what, script) => {
    fake.enqueue(script);
    const provider = containerCredentialProvider({ url: new URL(`${fake.url}/creds`) });
    await expect(provider()).rejects.toBeInstanceOf(CredentialsError);
  });

  it('rejects an unreadable token file and an unreachable endpoint', async () => {
    await expect(
      containerCredentialProvider({ url: new URL(`${fake.url}/creds`), tokenFile: path.join(dir, 'missing') })(),
    ).rejects.toThrow('token file');
    const port = fake.port;
    await fake.close();
    await expect(containerCredentialProvider({ url: new URL(`http://127.0.0.1:${port}/creds`) })()).rejects.toThrow(
      'unreachable',
    );
    fake = await startFake();
  });

  it('allows plain HTTP only to loopback and the ECS and EKS link-local hosts', () => {
    const uri = (value: string) => () => containerSource({ AWS_CONTAINER_CREDENTIALS_FULL_URI: value });
    expect(uri('http://169.254.170.23/v1/credentials')()?.url.host).toBe('169.254.170.23');
    expect(uri('http://169.254.170.2/v2/credentials')()?.url.host).toBe('169.254.170.2');
    expect(uri('http://[fd00:ec2::23]/v1/credentials')()?.url.hostname).toBe('[fd00:ec2::23]');
    expect(uri('http://localhost:9000/creds')()?.url.port).toBe('9000');
    expect(uri('https://creds.example.com/v1')()?.url.protocol).toBe('https:');
    expect(uri('http://creds.example.com/v1')).toThrow(CredentialsError);
    expect(uri('file:///etc/passwd')).toThrow(CredentialsError);
    expect(containerSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' })?.url.href).toBe(
      'http://169.254.170.2/v2/credentials/abc',
    );
    expect(containerSource({})).toBeNull();
  });
});

describe('the default chain', () => {
  it('prefers environment keys, then the container endpoint', async () => {
    expect(
      await defaultCredentialProvider({
        AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 's',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${fake.url}/creds`,
      })(),
    ).toEqual({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's' });
    expect(fake.requests).toHaveLength(0);
    fake.enqueue(answer(200, issued(3, '2099-01-01T00:00:00Z')));
    const fromContainer = await defaultCredentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `${fake.url}/creds` })();
    expect(fromContainer.accessKeyId).toBe('ASIAFAKE3');
  });

  it('fails clearly with no source', async () => {
    await expect(defaultCredentialProvider({})()).rejects.toThrow('No AWS credentials');
  });
});
