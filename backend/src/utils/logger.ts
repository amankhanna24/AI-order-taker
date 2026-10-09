import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

/** Writes one JSON line per error to a daily file. Never logs request bodies or secrets. */
export function logError(context: string, err: unknown, extra?: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const entry = { time: new Date().toISOString(), context, message: e.message, stack: e.stack, ...extra };
  console.error(`[${context}] ${e.message}`);
  try {
    fs.mkdirSync(env.LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(env.LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), JSON.stringify(entry) + '\n');
  } catch {
    /* logging must never throw */
  }
}
