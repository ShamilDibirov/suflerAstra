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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  type ModelCallLog,
} from '@sufler/shared';
import { audioRange } from './audio-range';
import { audioLayout, audioBytes } from './unified-audio';
import {
  ensureSession,
  requireWorkSession,
  switchClient,
  undoClientSwitch,
  finishWorkingSession,
} from './working-sessions';
import { saveTariff, summarize } from './billing';
import { config } from './config';
import { getPrompts, savePrompts } from './prompts';
import { DEFAULT_PROMPTS } from '@sufler/shared';
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
import { saveDocument, publishDocument, addSalesTemplates } from './knowledge';
import { draftProcess, testModel, testDecisionModel, providerError } from './ai';
import { putFile } from './storage';
import { enqueueIngest, deleteConversation } from './infra';
import { fromNodeHeaders } from 'better-auth/node';

@Controller('api')
export class ApiController {
  @Get('sessions/:id') async workSession(@Req() req: Request, @Param('id') id: string) {
    const user = await session(req);
    const c = await requireConversation(user, id, true);
    return ensureSession(user, c);
  }
  @Post('sessions/:id/finish') async finishWork(@Req() req: Request, @Param('id') id: string) {
    return finishWorkingSession(await session(req), id);
  }
  @Post('sessions/:id/next') async nextClient(@Req() req: Request, @Param('id') id: string) {
    const user = await session(req);
    await requireWorkSession(user, id);
    return switchClient(user, id);
  }
  @Post('sessions/:id/undo') async undoClient(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return undoClientSwitch(
      await session(req),
      id,
      z.object({ boundaryId: z.string() }).parse(body).boundaryId,
    );
  }
  @Get('admin/tariffs') async tariffs(@Req() req: Request) {
    const u = await session(req);
    assertAdmin(u);
    return store.list(u.orgId, 'tariff');
  }
  @Post('admin/tariffs') async tariff(@Req() req: Request, @Body() body: unknown) {
    const u = await session(req);
    assertAdmin(u);
    try {
      return await saveTariff(u.orgId, body);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Некорректный тариф');
    }
  }
  @Get('admin/metrics') async metrics(@Req() req: Request) {
    const u = await session(req);
    assertAdmin(u);
    const q = z
      .object({
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        model: z.string().optional(),
        type: z.string().optional(),
        user: z.string().optional(),
      })
      .parse(req.query);
    const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10),
      from = q.from || new Date(Date.now() + 3 * 3600000 - 6 * 86400000).toISOString().slice(0, 10),
      to = q.to || today;
    const start = Date.parse(`${from}T00:00:00+03:00`),
      end = Date.parse(`${to}T00:00:00+03:00`) + 86400000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new BadRequestException('Некорректный период');
    const all = await store.list<ModelCallLog>(u.orgId, 'model-call');
    const calls = all.filter(
      (c) =>
        Date.parse(c.at) >= start &&
        Date.parse(c.at) < end &&
        (!q.model || c.model === q.model) &&
        (!q.type || c.type === q.type) &&
        (!q.user || c.userId === q.user),
    );
    const ids = new Set(calls.map((c) => c.conversationId));
    const conversations = (await store.list<Conversation>(u.orgId, 'conversation'))
      .filter(
        (c) =>
          !c.mergedInto &&
          (!q.user || c.userId === q.user) &&
          (ids.has(c.id) ||
            (!q.model &&
              !q.type &&
              Date.parse(c.createdAt) >= start &&
              Date.parse(c.createdAt) < end)),
      )
      .map((c) => ({
        ...c,
        hints: c.hints.filter(
          (h) =>
            Date.parse(h.createdAt) >= start &&
            Date.parse(h.createdAt) < end &&
            (!q.model || h.modelId === q.model),
        ),
      }));
    return {
      ...summarize(calls, conversations),
      from,
      to,
      retentionDays: config.retentionDays,
      models: [...new Set(all.map((c) => c.model))],
      types: [...new Set(all.map((c) => c.type))],
      users: [...new Set(all.flatMap((c) => (c.userId ? [c.userId] : [])))],
      userNames: Object.fromEntries(
        (await this.users(req)).map((v: { id: string; name: string }) => [v.id, v.name]),
      ),
    };
  }
  @Get('conversations/:id/audio') async unifiedAudio(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    const c = await requireConversation(await session(req), id);
    if (!c.recordings.length) throw new NotFoundException('Запись отсутствует');
    return this.streamRecording(req, res, c.recordings, c.id);
  }
  private async streamRecording(
    req: Request,
    res: Response,
    recordings: Conversation['recordings'],
    id: string,
  ) {
    const layout = audioLayout(recordings),
      range = req.headers.range
        ? audioRange(req.headers.range, layout.length)
        : { start: 0, end: layout.length - 1 };
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('audio/wav');
    if (!range) {
      res.setHeader('Content-Range', `bytes */${layout.length}`);
      res.status(416).end();
      return;
    }
    if (req.headers.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${layout.length}`);
    }
    res.setHeader('Content-Length', range.end - range.start + 1);
    if (req.query.download === '1')
      res.setHeader('Content-Disposition', `attachment; filename="dialog-${id}.wav"`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      await pipeline(
        Readable.from(audioBytes(recordings, range.start, range.end, abort.signal)),
        res,
      );
    } catch (e) {
      if (!abort.signal.aborted) res.destroy(e as Error);
    }
  }

  @Get('admin/prompts') async prompts(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    return { settings: await getPrompts(user.orgId), defaults: DEFAULT_PROMPTS };
  }
  @Post('admin/prompts') async updatePrompts(@Req() req: Request, @Body() body: unknown) {
    return savePrompts(await session(req), body);
  }
  @Post('admin/classifier/test') async classifierTest(@Req() req: Request) {
    assertAdmin(await session(req));
    try {
      return await testDecisionModel();
    } catch (error) {
      throw new BadRequestException(providerError(error));
    }
  }
  private async voiceRequest(req: Request, action: 'status' | 'delete' | 'sample') {
    const user = await session(req);
    if (config.demo) return null;
    const response = await fetch(`${config.speech}/profile/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.internalToken },
      body: JSON.stringify({ profileId: `${user.orgId}:${user.id}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw new BadRequestException('Сохранённый профиль голоса недоступен. Проверьте speech.');
    return response;
  }
  @Get('voice-profile') async voiceProfile(@Req() req: Request) {
    return (await this.voiceRequest(req, 'status'))?.json() || { available: false };
  }
  @Delete('voice-profile') async removeVoiceProfile(@Req() req: Request) {
    return (await this.voiceRequest(req, 'delete'))?.json() || { ok: true };
  }
  @Get('voice-profile/sample') async voiceSample(@Req() req: Request, @Res() res: Response) {
    const response = await this.voiceRequest(req, 'sample');
    if (!response) throw new NotFoundException();
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(await response.arrayBuffer()));
  }
  @Get('health') health() {
    return { ok: true, service: 'sufler-api' };
  }
  @Get('config') publicConfig() {
    return {
      demo: config.demo,
      recordAudio: config.recordAudio,
      retentionDays: config.retentionDays,
      ragEnabled: config.ragEnabled,
      defaultAssistanceMode: config.defaultAssistanceMode,
    };
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
      .filter((c) => c.userId === user.id && !c.mergedInto)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  @Post('conversations') async create(@Req() req: Request, @Body() body: unknown) {
    const data = z
      .object({ modelId: z.string().optional(), previousId: z.string().optional() })
      .parse(body || {});
    return createConversation(await session(req), data.modelId, data.previousId);
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
          assistanceMode: z.enum(['rag', 'scripts']).optional(),
          salesScriptId: z.string().nullable().optional(),
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
    const [docs, allConversations, usage] = await Promise.all([
      store.list<KnowledgeDocument>(user.orgId, 'document'),
      store.list<Conversation>(user.orgId, 'conversation'),
      store.list<ModelCallLog>(user.orgId, 'model-call'),
    ]);
    const conversations = allConversations.filter((c) => !c.mergedInto);
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
      tokens: usage.reduce((s, u) => s + (u.inputTokens || 0) + (u.outputTokens || 0), 0),
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
  @Post('admin/sales-templates') async salesTemplates(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    return addSalesTemplates(user);
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
    if (!config.ragEnabled && (ext === 'pdf' || ext === 'docx'))
      throw new BadRequestException(
        'В режиме без RAG используйте текст, Markdown или CSV; PDF/DOCX предварительно преобразуйте в текст',
      );
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
        testError: providerError(e),
      });
      throw new BadRequestException(providerError(e));
    }
  }
  @Get('admin/history') async history(@Req() req: Request) {
    const user = await session(req);
    assertAdmin(user);
    return (await store.list<Conversation>(user.orgId, 'conversation'))
      .filter((c) => !c.mergedInto)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  @Get('admin/history/:id/analytics') async analytics(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const user = await session(req);
    assertAdmin(user);
    const conversation = await requireConversation(user, id);
    const calls = (await store.list<ModelCallLog>(user.orgId, 'model-call'))
      .filter((c) => c.conversationId === id)
      .sort((a, b) => a.at.localeCompare(b.at));
    return {
      conversation,
      calls,
      summary: summarize(calls, [conversation]),
      recordingEnabled: config.recordAudio,
      retentionDays: config.retentionDays,
    };
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
    return this.streamRecording(req, res, [audio], c.id);
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
