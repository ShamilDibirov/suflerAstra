import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { parse } from 'csv-parse/sync';
import {
  ModelInput,
  SegmentSchema,
  MODEL_DEFAULTS,
  type Conversation,
  type KnowledgeDocument,
  type ModelConfig,
} from '@sufler/shared';
import { config } from './config';
import { session, assertAdmin, auth } from './auth';
import { store, pool } from './store';
import {
  createConversation,
  requireConversation,
  addSegment,
  editSegment,
  configureConversation,
  makeHint,
  finish,
  models,
  cancel,
} from './conversations';
import { saveDocument, publishDocument } from './knowledge';
import { draftProcess, testModel } from './ai';
import { putFile, getFile } from './storage';
import { enqueueIngest, deleteConversation } from './infra';
import { fromNodeHeaders } from 'better-auth/node';

@Controller('api')
export class ApiController {
  @Get('health') health() {
    return { ok: true, service: 'sufler-api' };
  }
  @Get('config') publicConfig() {
    return { demo: config.demo };
  }
  @Get('session') me(@Req() req: Request) {
    return session(req);
  }
  @Get('models') async modelList(@Req() req: Request) {
    const user = await session(req);
    return (await models(user.orgId)).filter((m) => m.enabled);
  }
  @Get('conversations') async conversationList(@Req() req: Request) {
    const user = await session(req);
    return (await store.list<Conversation>(user.orgId, 'conversation'))
      .filter((c) => c.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  @Post('conversations') async create(@Req() req: Request, @Body() body: unknown) {
    const data = z.object({ modelId: z.string().optional() }).parse(body || {});
    return createConversation(await session(req), data.modelId);
  }
  @Get('conversations/:id') async get(@Req() req: Request, @Param('id') id: string) {
    return requireConversation(await session(req), id);
  }
  @Post('conversations/:id/segments') async segment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = body as Record<string, unknown>;
    const segment = SegmentSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      confidence: 1,
      final: true,
    });
    return addSegment(await session(req), id, segment);
  }
  @Patch('conversations/:id/segments/:segmentId') async correction(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('segmentId') segmentId: string,
    @Body() body: unknown,
  ) {
    return editSegment(
      await session(req),
      id,
      segmentId,
      z
        .object({
          text: z.string().min(1).max(4000).optional(),
          role: SegmentSchema.shape.role.optional(),
          excluded: z.boolean().optional(),
        })
        .strict()
        .parse(body),
    );
  }
  @Patch('conversations/:id') async configure(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return configureConversation(
      await session(req),
      id,
      z
        .object({
          modelId: z.string().optional(),
          autoHints: z.boolean().optional(),
          region: z.string().min(1).max(80).optional(),
          completedStep: z.string().optional(),
          intent: z.string().optional(),
          label: z.string().min(1).max(80).optional(),
        })
        .strict()
        .parse(body),
    );
  }
  @Post('conversations/:id/hint') async hint(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return makeHint(
      await session(req),
      id,
      z.object({ question: z.string().max(2000).default('') }).parse(body || {}).question,
    );
  }
  @Post('conversations/:id/finish') async end(@Req() req: Request, @Param('id') id: string) {
    return finish(await session(req), id);
  }
  @Delete('conversations/:id') async remove(@Req() req: Request, @Param('id') id: string) {
    const user = await session(req);
    await finish(user, id);
    const c = await requireConversation(user, id, true);
    cancel(id);
    await deleteConversation(user.orgId, c);
    return { ok: true };
  }
  @Post('chat/:id') async chat(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = z.object({ message: z.string().min(1).max(2000) }).parse(body);
    const h = await makeHint(await session(req), id, data.message);
    if (!h) throw new BadRequestException('Контекст изменился. Повторите вопрос.');
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'start', messageId: h.id });
        writer.write({ type: 'text-start', id: h.id });
        writer.write({ type: 'text-delta', id: h.id, delta: h.text });
        writer.write({ type: 'text-end', id: h.id });
        writer.write({ type: 'data-hint', data: h });
        writer.write({ type: 'finish' });
      },
    });
    const response = createUIMessageStreamResponse({ stream });
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.status(response.status);
    const reader = response.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }
  @Get('knowledge') async knowledge(@Req() req: Request) {
    const user = await session(req);
    return (await store.list<KnowledgeDocument>(user.orgId, 'document')).filter(
      (d) => d.status === 'published',
    );
  }
  @Get('knowledge/:id') async source(@Req() req: Request, @Param('id') id: string) {
    const user = await session(req);
    const d = await store.get<KnowledgeDocument>(user.orgId, 'document', id);
    if (!d || (d.status !== 'published' && user.role === 'consultant'))
      throw new NotFoundException();
    return d;
  }
  @Get('admin/overview') async overview(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    const [docs, conversations, usage] = await Promise.all([
      store.list<KnowledgeDocument>(user.orgId, 'document'),
      store.list<Conversation>(user.orgId, 'conversation'),
      store.list<{ inputTokens: number; outputTokens: number }>(user.orgId, 'usage'),
    ]);
    const hints = conversations.flatMap((c) => c.hints);
    return {
      documents: docs.length,
      published: docs.filter((d) => d.status === 'published').length,
      conversations: conversations.length,
      active: conversations.filter((c) => c.status === 'active').length,
      hints: hints.length,
      grounded: hints.filter((h) => h.blocks.length).length,
      avgLatency: hints.length
        ? Math.round(hints.reduce((s, h) => s + h.latencyMs, 0) / hints.length)
        : 0,
      tokens:
        usage.reduce((s, u) => s + (u.inputTokens || 0) + (u.outputTokens || 0), 0) +
        hints.reduce((s, h) => s + h.inputTokens + h.outputTokens, 0),
      demo: config.demo,
    };
  }
  @Get('admin/documents') async documents(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    return store.list<KnowledgeDocument>(user.orgId, 'document');
  }
  @Post('admin/documents') async documentCreate(@Req() req: Request, @Body() body: unknown) {
    const user = await session(req);
    assertAdmin(user);
    const d = await saveDocument(user, body);
    await store.audit(user.orgId, user.id, 'document.create', d.id);
    return d;
  }
  @Patch('admin/documents/:id') async documentEdit(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = await session(req);
    assertAdmin(user);
    return saveDocument(user, body, id);
  }
  @Post('admin/documents/:id/status') async documentStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = await session(req);
    assertAdmin(user);
    const { status } = z
      .object({ status: z.enum(['review', 'published', 'archived']) })
      .parse(body);
    const d = await publishDocument(user, id, status);
    await store.audit(user.orgId, user.id, `document.${status}`, id);
    return d;
  }
  @Post('admin/documents/:id/draft-process') async processDraft(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const user = await session(req);
    assertAdmin(user);
    const d = await store.get<KnowledgeDocument>(user.orgId, 'document', id);
    if (!d) throw new NotFoundException();
    return draftProcess(d.content);
  }
  @Post('admin/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@Req() req: Request, @UploadedFile() file: Express.Multer.File) {
    const user = await session(req);
    assertAdmin(user);
    if (!file) throw new BadRequestException('Выберите файл');
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (!['txt', 'md', 'pdf', 'docx', 'csv'].includes(ext || ''))
      throw new BadRequestException('Поддерживаются PDF, DOCX, MD, TXT и CSV');
    const title = file.originalname.replace(/\.[^.]+$/, '');
    let content = 'Документ ожидает извлечения текста.';
    if (ext === 'txt' || ext === 'md') content = file.buffer.toString('utf-8');
    if (ext === 'csv') {
      const rows = parse(file.buffer, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];
      if (!rows.length || rows.length > 500)
        throw new BadRequestException('Каталог должен содержать от 1 до 500 строк');
      content = rows
        .map(
          (row) =>
            Object.entries(row)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n') + '\nНаличие требует проверки.',
        )
        .join('\n\n');
    }
    const doc = await saveDocument(user, {
      title: typeTitle(title),
      type: ext === 'csv' ? 'catalog' : 'article',
      intent: 'unknown',
      content,
    });
    doc.sourceName = file.originalname;
    doc.sourceKey = `${user.orgId}/documents/${doc.id}/original.${ext}`;
    await putFile(doc.sourceKey, file.buffer, file.mimetype);
    if (ext === 'pdf' || ext === 'docx') {
      if (config.demo) {
        doc.status = 'failed';
        doc.error =
          'Для PDF/DOCX запустите реальный сервис Docling. В демо доступны TXT, MD и CSV.';
      } else doc.status = 'processing';
    }
    await store.put(user.orgId, 'document', doc.id, doc);
    if (doc.status === 'processing') await enqueueIngest(user.orgId, doc.id);
    return doc;
  }
  @Get('admin/models') async adminModels(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    return models(user.orgId);
  }
  @Post('admin/models') async saveModel(@Req() req: Request, @Body() body: unknown) {
    const user = await session(req);
    assertAdmin(user);
    const data = ModelInput.parse(body);
    const all = await models(user.orgId);
    if (!data.enabled && data.isDefault)
      throw new BadRequestException('Модель по умолчанию должна быть включена');
    if (!all.some((m) => m.id !== data.id && m.enabled) && !data.enabled)
      throw new BadRequestException('Оставьте хотя бы одну модель');
    for (const m of all)
      await store.put(user.orgId, 'model', m.id, data.isDefault ? { ...m, isDefault: false } : m);
    const model = { ...data, testedAt: null, testError: null };
    await store.put(user.orgId, 'model', data.id, model);
    return model;
  }
  @Post('admin/models/test') async modelTest(@Req() req: Request, @Body() body: unknown) {
    const user = await session(req);
    assertAdmin(user);
    const { id } = z.object({ id: z.string() }).parse(body);
    const m = (await models(user.orgId)).find((m) => m.id === id);
    if (!m) throw new NotFoundException();
    try {
      const result = await testModel(id);
      await store.put(user.orgId, 'model', id, {
        ...m,
        testedAt: result.demo ? null : new Date().toISOString(),
        testError: null,
      });
      return result;
    } catch (e) {
      await store.put(user.orgId, 'model', id, {
        ...m,
        testError: e instanceof Error ? e.message : 'Ошибка',
      });
      throw new BadRequestException(
        'Модель недоступна или не поддерживает структурированный ответ',
      );
    }
  }
  @Get('admin/history') async history(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    return (await store.list<Conversation>(user.orgId, 'conversation')).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  @Get('recordings/:id/:index') async recording(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Param('index') index: string,
  ) {
    const c = await requireConversation(await session(req), id);
    const audio = c.recordings[Number(index)];
    if (!audio) throw new NotFoundException();
    const file = await getFile(audio.key);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(file.type).send(file.body);
  }
  @Get('admin/users') async users(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    if (config.demo) return [{ id: user.id, name: user.name, email: user.email, role: 'owner' }];
    const r = await pool!.query(
      'SELECT u.id,u.name,u.email,m.role FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1',
      [user.orgId],
    );
    return r.rows;
  }
  @Post('admin/users') async addUser(@Req() req: Request, @Body() body: unknown) {
    const user = await session(req);
    assertAdmin(user);
    const d = z
      .object({
        name: z.string().min(2).max(80),
        email: z.email(),
        password: z.string().min(12).max(128),
        role: z.enum(['admin', 'consultant']),
      })
      .parse(body);
    if (config.demo)
      throw new BadRequestException('Учётные записи создаются в реальном режиме с PostgreSQL');
    // createUser's global admin API is deliberately not exposed. This trusted server call
    // creates a normal account, and membership is always bound to the caller's org.
    const ctx = await auth!.$context;
    const existing = await ctx.internalAdapter.findUserByEmail(d.email);
    if (existing) throw new BadRequestException('Такой email уже существует');
    const created = await ctx.internalAdapter.createUser(
      { name: d.name, email: d.email, emailVerified: false },
      { method: 'admin' },
    );
    try {
      const hash = await ctx.password.hash(d.password);
      await ctx.internalAdapter.linkAccount({
        userId: created.id,
        providerId: 'credential',
        accountId: created.id,
        password: hash,
      });
      await pool!.query(
        'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,now())',
        [randomUUID(), user.orgId, created.id, d.role === 'consultant' ? 'member' : 'admin'],
      );
    } catch (e) {
      await ctx.internalAdapter.deleteUser(created.id);
      throw e;
    }
    await store.audit(user.orgId, user.id, 'user.create', created.id);
    return { id: created.id, name: created.name, email: created.email, role: d.role };
  }
  @Get('organizations') async orgs(@Req() req: Request) {
    const user = await session(req);
    if (config.demo) return [{ id: user.orgId, name: user.orgName }];
    const r = await pool!.query(
      'SELECT o.id,o.name FROM organization o JOIN member m ON m."organizationId"=o.id WHERE m."userId"=$1',
      [user.id],
    );
    return r.rows;
  }
  @Post('organizations/switch') async switchOrg(@Req() req: Request, @Body() body: unknown) {
    const user = await session(req);
    const { id } = z.object({ id: z.string() }).parse(body);
    if (config.demo) throw new BadRequestException('В демо доступна учебная организация');
    const member = await pool!.query(
      'SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2',
      [id, user.id],
    );
    if (!member.rowCount) throw new ForbiddenException();
    for (const c of await store.list<Conversation>(user.orgId, 'conversation'))
      if (c.userId === user.id && c.status === 'active') await finish(user, c.id);
    await auth!.api.setActiveOrganization({
      headers: fromNodeHeaders(req.headers),
      body: { organizationId: id },
    });
    return { ok: true };
  }
}
function typeTitle(title: string) {
  return title.length < 3 ? `Документ ${title}` : title.slice(0, 160);
}
