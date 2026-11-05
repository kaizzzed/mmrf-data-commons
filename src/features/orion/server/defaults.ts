// The production wiring of the route handlers: the fork's session check, the environment, the
// default AWS credential chain and the process-wide session registry.

import { sessionCheck } from './auth';
import { readConfig } from './config';
import { defaultCredentialProvider } from './credentials';
import type { HandlerDeps } from './handlers';
import { DEFAULT_TIMERS } from './relay';
import { sharedSessions } from './sessions';

export const defaultDeps = (): HandlerDeps => ({
  authenticate: sessionCheck,
  config: () => readConfig(process.env),
  credentials: defaultCredentialProvider(process.env),
  sessions: sharedSessions(),
  timers: DEFAULT_TIMERS,
  now: Date.now,
});
