export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  debug(message: string, extra?: Record<string, unknown>): void;
}

export function createLogger(context: string): Logger {
  const log = (level: string, message: string, extra?: Record<string, unknown>) => {
    const entry = { timestamp: new Date().toISOString(), level, context, message, ...extra };
    console.log(JSON.stringify(entry));
  };

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    debug: (msg, extra) => log('debug', msg, extra),
  };
}
