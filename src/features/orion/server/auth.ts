import type { IncomingMessage } from 'node:http';
import { getLoginStatus } from '@/lib/auth/getLoginStatus';

export type Authenticate = (req: IncomingMessage) => Promise<boolean>;

/**
 * The fork's API session check (as in pages/api/terms): a verified, unexpired Fence access token
 * in the cookies. In the sandbox the identity gateway supplies it on every request.
 */
export const sessionCheck: Authenticate = async (req) =>
  (await getLoginStatus(req.headers.cookie)).status === 'issued';
