import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  ADMIN_API_KEY: z.string().optional().default(''),
  DEFAULT_RESTAURANT_SLUG: z.string().default('green-spoon-kitchen'),
  LOG_DIR: z.string().default('logs'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration — ${issues}`);
}

export const env = parsed.data;
if (env.NODE_ENV === 'production' && env.ADMIN_API_KEY.length < 24) {
  throw new Error('ADMIN_API_KEY must be set (>= 24 chars) in production');
}
