import { defaultDeps } from '@/features/orion/server/defaults';
import { createRecordHandler } from '@/features/orion/server/handlers';

// Records hold every call's full output and can be several megabytes.
export const config = { api: { responseLimit: false } };

/** GET /api/orion/runs/[runId]/record[?threadId=&download=1]: the stored run record (FR-20 export). */
export default createRecordHandler(defaultDeps());
