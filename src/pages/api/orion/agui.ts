import { defaultDeps } from '@/features/orion/server/defaults';
import { createAguiHandler } from '@/features/orion/server/handlers';

// The body is forwarded as received (no parsing, no size limit here: the handler caps it), and
// the event stream is relayed chunk by chunk with no response size limit.
export const config = { api: { bodyParser: false, responseLimit: false } };

/** POST /api/orion/agui: one turn, RunAgentInput in, the agent's AG-UI event stream out. */
export default createAguiHandler(defaultDeps());
