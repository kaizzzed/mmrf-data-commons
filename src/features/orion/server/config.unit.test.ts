/** @jest-environment node */
import { ConfigError, readConfig } from './config';
import { TEST_RUNTIME_ARN } from './testHarness';

const AWS = { ORION_RUNTIME_ARN: TEST_RUNTIME_ARN, ORION_RUN_BUCKET: 'orion-runs-example' };

describe('BFF configuration', () => {
  it('defaults to mode L with the contract defaults', () => {
    expect(readConfig({})).toEqual({
      mode: 'L',
      agentUrl: new URL('http://orion-agent:8080'),
      runDir: '/data/runs',
    });
  });

  it('reads mode L settings', () => {
    const config = readConfig({ ORION_MODE: 'L', ORION_AGENT_URL: 'http://localhost:9090/', ORION_RUN_DIR: '/tmp/runs' });
    expect(config).toEqual({ mode: 'L', agentUrl: new URL('http://localhost:9090/'), runDir: '/tmp/runs' });
  });

  it('reads modes A and H with the contract defaults', () => {
    for (const mode of ['A', 'H'] as const) {
      expect(readConfig({ ORION_MODE: mode, ...AWS })).toEqual({
        mode,
        region: 'us-east-1',
        runtimeArn: TEST_RUNTIME_ARN,
        qualifier: 'DEFAULT',
        runBucket: 'orion-runs-example',
        runPrefix: 'orion/',
        agentCoreEndpoint: new URL('https://bedrock-agentcore.us-east-1.amazonaws.com'),
        s3Endpoint: null,
      });
    }
  });

  it('reads the qualifier, region, prefix and endpoint overrides', () => {
    const config = readConfig({
      ORION_MODE: 'A',
      ...AWS,
      AWS_REGION: 'us-west-2',
      ORION_RUNTIME_QUALIFIER: 'live',
      ORION_RUN_PREFIX: '',
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: 'http://127.0.0.1:4566',
      AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:4567',
    });
    expect(config).toMatchObject({
      region: 'us-west-2',
      qualifier: 'live',
      runPrefix: '',
      agentCoreEndpoint: new URL('http://127.0.0.1:4566'),
      s3Endpoint: new URL('http://127.0.0.1:4567'),
    });
  });

  it.each([
    [{ ORION_MODE: 'X' }, 'ORION_MODE'],
    [{ ORION_AGENT_URL: 'ftp://agent' }, 'ORION_AGENT_URL'],
    [{ ORION_AGENT_URL: 'http://user:pass@agent:8080' }, 'ORION_AGENT_URL'],
    [{ ORION_MODE: 'A', ORION_RUN_BUCKET: 'b-bucket' }, 'ORION_RUNTIME_ARN'],
    [{ ORION_MODE: 'A', ...AWS, ORION_RUNTIME_ARN: 'arn:aws:lambda:us-east-1:123456789012:function:x' }, 'ORION_RUNTIME_ARN'],
    [{ ORION_MODE: 'H', ORION_RUNTIME_ARN: TEST_RUNTIME_ARN }, 'ORION_RUN_BUCKET'],
    [{ ORION_MODE: 'A', ...AWS, ORION_RUNTIME_QUALIFIER: 'a b' }, 'ORION_RUNTIME_QUALIFIER'],
    [{ ORION_MODE: 'A', ...AWS, AWS_REGION: 'mars' }, 'AWS_REGION'],
    [{ ORION_MODE: 'A', ...AWS, ORION_RUN_PREFIX: '/abs/' }, 'ORION_RUN_PREFIX'],
    [{ ORION_MODE: 'A', ...AWS, AWS_ENDPOINT_URL_S3: 'http://x/?q=1' }, 'AWS_ENDPOINT_URL_S3'],
  ])('rejects %j (%s)', (env, name) => {
    expect(() => readConfig(env)).toThrow(ConfigError);
    expect(() => readConfig(env)).toThrow(name);
  });
});
