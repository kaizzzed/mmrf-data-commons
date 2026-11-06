import type { IconType } from 'react-icons';
import {
  LuBan,
  LuCheck,
  LuCircle,
  LuCircleCheck,
  LuCircleHelp,
  LuCirclePause,
  LuCircleSlash2,
  LuCircleX,
  LuEye,
  LuHand,
  LuHourglass,
  LuLink,
  LuLoaderCircle,
  LuMinus,
  LuOctagon,
  LuPenLine,
  LuRotateCw,
  LuSquare,
  LuTriangleAlert,
  LuUnlink,
  LuX,
} from 'react-icons/lu';
import type { RunStatus, StepStatus } from './agui/types';

/** Every state pairs an icon with a word, so status never relies on color. */
export interface StatusVocab {
  word: string;
  Icon: IconType;
  spinning: boolean;
}

const vocab = (word: string, Icon: IconType, spinning = false): StatusVocab => ({
  word,
  Icon,
  spinning,
});

// Screen words and icons from F2 "Run and step states".
export const RUN_STATUS_VOCAB: Record<RunStatus, StatusVocab> = {
  Planning: vocab('Planning', LuLoaderCircle, true),
  Clarifying: vocab('Question for you', LuCircleHelp),
  AwaitingConsent: vocab('Needs your choice', LuHand),
  Executing: vocab('Running', LuLoaderCircle, true),
  AwaitingConfirmation: vocab('Waiting for you', LuCirclePause),
  Stopping: vocab('Stopping', LuHourglass),
  Answering: vocab('Writing interpretation', LuPenLine),
  Complete: vocab('Complete', LuCircleCheck),
  Partial: vocab('Partial: a step failed', LuTriangleAlert),
  Limited: vocab('Stopped by a limitation', LuOctagon),
  Unsupported: vocab('Not supported', LuBan),
  ObservedOnly: vocab('Interpretation withheld', LuEye),
  Cancelled: vocab('Stopped by you', LuSquare),
  Failed: vocab('Failed', LuCircleX),
  Interrupted: vocab('Interrupted', LuUnlink),
};

export const STEP_STATUS_VOCAB: Record<StepStatus, StatusVocab> = {
  Queued: vocab('Next', LuCircle),
  AwaitingUser: vocab('Needs you', LuCirclePause),
  Running: vocab('Running', LuLoaderCircle, true),
  Retrying: vocab('Retrying', LuRotateCw),
  Done: vocab('Done', LuCheck),
  Empty: vocab('Empty', LuCircleSlash2),
  Failed: vocab('Failed', LuX),
  Skipped: vocab('Skipped', LuMinus),
  Reused: vocab('Reused', LuLink),
};
