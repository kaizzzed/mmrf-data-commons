// One JSON line per BFF event. Fields are ids, statuses and reasons only: never a body, a header
// value, a cohort or a credential.

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

const consoleLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ orion: 'bff', level, event, ...fields });
  if (level === 'info') console.info(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
};

let current: Logger = consoleLogger;

export const log: Logger = (level, event, fields) => current(level, event, fields);

/** Tests swap the logger; returns the previous one. */
export const setLogger = (logger: Logger): Logger => {
  const previous = current;
  current = logger;
  return previous;
};
