import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';
import { globalLimiter } from './middleware/security';
import { adminRouter, router } from './routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use(globalLimiter);

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/v1', router);
  app.use('/api/v1/admin', adminRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
