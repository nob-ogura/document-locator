export type LogLevel = "debug" | "info" | "error";

type LogContext = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  error: 30,
};

const shouldLog = (currentLevel: LogLevel, messageLevel: LogLevel): boolean =>
  LEVEL_WEIGHT[messageLevel] >= LEVEL_WEIGHT[currentLevel];

const formatPayload = (level: LogLevel, message: string, context?: LogContext): string => {
  const payload: Record<string, unknown> = {
    level,
    message,
  };

  if (context && Object.keys(context).length > 0) {
    payload.context = context;
  }

  return `${JSON.stringify(payload)}\n`;
};

export type Logger = {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
};

export const createLogger = (logLevel: LogLevel = "info"): Logger => {
  const log = (level: LogLevel, message: string, context?: LogContext): void => {
    if (!shouldLog(logLevel, level)) return;

    const output = formatPayload(level, message, context);
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(output);
  };

  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    error: (message, context) => log("error", message, context),
  };
};
