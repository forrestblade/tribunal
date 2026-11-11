// One place for log output so the format (and, later, the destination) can change.

type Level = "info" | "warn" | "error";

function write(level: Level, message: string, detail?: unknown) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (detail === undefined) sink(line);
  else sink(line, detail);
}

export const logger = {
  info: (message: string, detail?: unknown) => write("info", message, detail),
  warn: (message: string, detail?: unknown) => write("warn", message, detail),
  error: (message: string, detail?: unknown) => write("error", message, detail),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
