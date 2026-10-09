import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { geminiEnabled } from './llm/gemini';
import { logError } from './utils/logger';

const app = createApp();
const server = app.listen(env.PORT, () => {
  const brain = geminiEnabled() ? `Gemini ${env.GEMINI_MODEL}` : 'deterministic fallback parser (set GEMINI_API_KEY to enable the LLM)';
  console.log(`Order Taker API listening on :${env.PORT} — ${brain}`);
});

process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
const shutdown = () => server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
