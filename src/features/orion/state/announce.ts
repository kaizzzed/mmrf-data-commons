import { isEndStatus, type RunState } from '../agui/reducer';
import { RUN_STATUS_VOCAB, STEP_STATUS_VOCAB } from '../status';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a waiting run asks, so the card is announced even when focus stays in the composer (E21). */
const waitingText = (run: RunState): string | null => {
  const pending = run.view?.pending;
  const word = RUN_STATUS_VOCAB[run.status].word;
  if (run.status === 'AwaitingConfirmation' && pending?.kind === 'confirm') {
    return `${word}: save ${plural(pending.cohorts.length, 'cohort')}?`;
  }
  if (run.status === 'Clarifying' && pending?.kind === 'clarify') return `${word}: ${pending.question}`;
  if (run.status === 'AwaitingConsent' && pending?.kind === 'consent') {
    return `${word}: use ${pending.proposed.title} instead of ${pending.named.title}?`;
  }
  return null;
};

/**
 * Text for the polite live region when a run moves on: each step that changed status, then the
 * run's own word once it changes — what a waiting card asks, "Writing interpretation", or the
 * finished answer. Null when nothing did.
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
  const newPlan = !!next.view?.plan && next.view.plan.version !== prev?.view?.plan?.version;
  if (newPlan && next.view?.plan && next.view.plan.version > 1) {
    parts.push(`Plan version ${next.view.plan.version}.`);
  }
  if (prev?.status !== next.status) {
    const word = RUN_STATUS_VOCAB[next.status].word;
    const waiting = waitingText(next);
    if (waiting) {
      parts.push(waiting);
    } else if (isEndStatus(next.status)) {
      parts.push(next.view?.observed.length ? `Answer ready: ${word}.` : `Run ended: ${word}.`);
    } else if (prev) {
      parts.push(`${word}.`);
    }
  }
  return parts.length ? parts.join(' ') : null;
};
