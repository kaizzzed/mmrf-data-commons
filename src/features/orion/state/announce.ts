import { isEndStatus, type RunState } from '../agui/reducer';
import { RUN_STATUS_VOCAB, STEP_STATUS_VOCAB } from '../status';

/**
 * Text for the polite live region when a run moves on: each step that changed
 * status, then the run's own word once it waits or ends. Null when nothing did.
 */
export const describeRunChange = (
  prev: RunState | undefined,
  next: RunState,
): string | null => {
  const parts: string[] = [];
  const before = new Map(prev?.view?.steps.map((s) => [s.id, s.status]) ?? []);
  for (const step of next.view?.steps ?? []) {
    const was = before.get(step.id);
    if (was !== undefined && was !== step.status) {
      parts.push(`Step ${step.id} ${step.tool}: ${STEP_STATUS_VOCAB[step.status].word}.`);
    }
  }
  if (prev?.status !== next.status) {
    const word = RUN_STATUS_VOCAB[next.status].word;
    if (isEndStatus(next.status)) {
      parts.push(next.view?.observed.length ? `Answer ready: ${word}.` : `Run ended: ${word}.`);
    } else if (prev) {
      parts.push(`${word}.`);
    }
  }
  return parts.length ? parts.join(' ') : null;
};
