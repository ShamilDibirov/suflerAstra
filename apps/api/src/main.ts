import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  Module,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import express from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { ZodError } from 'zod';
import { ApiController } from './controller';
import { config, validateConfig } from './config';
import { auth, assertOrigin, demoUser } from './auth';
import { store } from './store';
import { startJobs } from './infra';
import { setupLive } from './live';
import { demoDocuments, demoClassification, DEMO_SCENARIO } from '@sufler/shared/demo';
import { MODEL_DEFAULTS } from '@sufler/shared';
import { newConversation, applyPatch, renderHint, evidenceFor } from '@sufler/shared/engine';
import { randomUUID } from 'node:crypto';

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const status =
      error instanceof HttpException ? error.getStatus() : error instanceof ZodError ? 400 : 500;
    const message =
      error instanceof ZodError
        ? 'Проверьте поля запроса'
        : error instanceof HttpException
          ? error.message
          : 'Не удалось выполнить запрос. Проверьте состояние подключений.';
    if (status === 500)
      console.error('Request failed', error instanceof Error ? error.message : 'Unknown');
    res.status(status).json({ statusCode: status, message });
  }
}
@Module({ controllers: [ApiController] })
class AppModule {}
async function seedDemo() {
  const docs = demoDocuments();
  for (const d of docs) await store.put(d.orgId, 'document', d.id, d);
  for (const m of MODEL_DEFAULTS) await store.put(demoUser.orgId, 'model', m.id, m);
  const c = newConversation(demoUser.orgId, demoUser.id, MODEL_DEFAULTS[0].id, 'Клиент №01');
  c.segments = DEMO_SCENARIO.slice(0, 2).map((s, i) => ({
    ...s,
    id: randomUUID(),
    speakerId: s.role,
    startMs: i * 5000,
    endMs: i * 5000 + 4000,
    confidence: 1,
    final: true,
    excluded: false,
    createdAt: new Date(Date.now() - (2 - i) * 10000).toISOString(),
  }));
  c.card = applyPatch(
    { ...c.card, revision: 2 },
    demoClassification(c.segments),
    c.segments,
    'demo',
  );
  c.hints = [renderHint(c.card, [evidenceFor(docs[0], docs[0].blocks[0].id)!], c.modelId)];
  await store.put(c.orgId, 'conversation', c.id, c);
}
async function main() {
  validateConfig();
  if (config.demo) await seedDemo();
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  const server = app.getHttpAdapter().getInstance();
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }),
  );
  app.enableCors({
    origin: [config.origin, ...(config.demo ? ['http://127.0.0.1:3000'] : [])],
    credentials: true,
  });
  if (auth) server.all('/api/auth/{*path}', toNodeHandler(auth));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  const limiter = new Map<string, { count: number; at: number }>();
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
      try {
        assertOrigin(req);
      } catch {
        return res.status(403).json({ message: 'Недопустимый Origin' });
      }
    }
    const key = req.ip || 'local',
      now = Date.now();
    const v = limiter.get(key);
    if (!v || now - v.at > 60000) limiter.set(key, { count: 1, at: now });
    else if (++v.count > 600)
      return res.status(429).json({ message: 'Слишком много запросов. Повторите через минуту.' });
    if (limiter.size > 10000)
      for (const [id, value] of limiter) if (now - value.at > 60000) limiter.delete(id);
    next();
  });
  app.useGlobalFilters(new Errors());
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  setupLive(app.getHttpServer());
  await startJobs();
  console.log(
    `Суфлёр API: http://${config.host}:${config.port} · ${config.demo ? 'DEMO (учебные данные)' : 'REAL'}`,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
