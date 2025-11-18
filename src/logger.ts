declare const process: any;

export type LogLevelName = 'debug' | 'info' | 'error';

interface LogLevelConfig {
  name: LogLevelName;
  priority: number;
}

const LOG_LEVELS: Record<LogLevelName, LogLevelConfig> = {
  debug: { name: 'debug', priority: 10 },
  info: { name: 'info', priority: 20 },
  error: { name: 'error', priority: 30 },
};

function normalizeLogLevelName(value: string | undefined): LogLevelName {
  if (!value) {
    return 'info';
  }

  const normalized = value.toLowerCase();

  if (normalized === 'debug') {
    return 'debug';
  }

  if (normalized === 'error') {
    return 'error';
  }

  return 'info';
}

function getCurrentLogLevel(): LogLevelConfig {
  const levelName = normalizeLogLevelName(process.env.LOG_LEVEL);
  return LOG_LEVELS[levelName];
}

function formatLogLine(level: LogLevelName, message: string): string {
  const timestamp = new Date().toISOString();
  const upperLevel = level.toUpperCase();
  return `${timestamp} ${upperLevel} ${message}`;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

class ConsoleLogger implements Logger {
  private readonly level: LogLevelConfig;

  constructor() {
    this.level = getCurrentLogLevel();
  }

  private shouldLog(level: LogLevelName): boolean {
    return LOG_LEVELS[level].priority >= this.level.priority;
  }

  debug(message: string): void {
    if (!this.shouldLog('debug')) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log(formatLogLine('debug', message));
  }

  info(message: string): void {
    if (!this.shouldLog('info')) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log(formatLogLine('info', message));
  }

  error(message: string): void {
    if (!this.shouldLog('error')) {
      return;
    }

    // eslint-disable-next-line no-console
    console.error(formatLogLine('error', message));
  }
}

let defaultLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new ConsoleLogger();
  }

  return defaultLogger;
}

