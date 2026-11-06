import { defaultDeps } from '@/features/orion/server/defaults';
import { createViewHandler } from '@/features/orion/server/handlers';

// A view is untrimmed and may exceed 32 KB.
export const config = { api: { responseLimit: false } };

/** GET /api/orion/runs/[runId]/view[?threadId=]: the run view, with the expired-lease rule applied. */
export default createViewHandler(defaultDeps());
