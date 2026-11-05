export type ComposerKeyAction = 'send' | 'stop' | 'newline' | 'hold' | 'none';

export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  /** True while an IME is composing; its Enter confirms the composition. */
  isComposing: boolean;
}

/**
 * Enter sends and Shift+Enter adds a line. While a run is active, typed text waits
 * in the composer ("hold") and Esc stops the run.
 */
export const composerKeyAction = (
  { key, shiftKey, isComposing }: ComposerKey,
  { running, hasText }: { running: boolean; hasText: boolean },
): ComposerKeyAction => {
  if (isComposing) return 'none';
  if (key === 'Escape') return running ? 'stop' : 'none';
  if (key !== 'Enter') return 'none';
  if (shiftKey) return 'newline';
  if (running || !hasText) return 'hold';
  return 'send';
};
