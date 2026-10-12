// Exercises the compiled API and real Better Auth against an isolated, disposable PostgreSQL.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');
const suffix = randomBytes(6).toString('hex'),
  name = `sufler-auth-test-${suffix}`;
const secret = randomBytes(24).toString('hex'),
  password = `test-${secret}`,
  port = 4011,
  origin = `http://127.0.0.1:${port}`;
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let server,
  log = '';
const voiceProfiles = new Set();
const speechMock = createServer(async (req, res) => {
  if (req.headers['x-internal-token'] !== secret) {
    res.writeHead(401).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const { profileId } = JSON.parse(raw);
  if (req.url === '/profile/sample') {
    if (!voiceProfiles.has(profileId)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(Buffer.from('RIFFsample'));
    return;
  }
  if (req.url === '/profile/delete') voiceProfiles.delete(profileId);
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ available: voiceProfiles.has(profileId), ok: true }));
});
let speechConnections = 0,
  speechFrames = 0;
const speechSockets = new WebSocketServer({ server: speechMock });
speechSockets.on('connection', (ws) => {
  speechConnections++;
  let duration = 0;
  ws.on('message', (data, binary) => {
    if (binary) {
      duration += data.length / 32;
      speechFrames++;
      return;
    }
    const message = JSON.parse(data.toString());
    if (message.type === 'start') ws.send(JSON.stringify({ type: 'ready' }));
    if (message.type === 'stop') {
      if (duration)
        ws.send(
          JSON.stringify({
            type: 'segment',
            text: 'Здравствуйте, выбираю телефон',
            speakerId: 'test:0',
            role: 'customer',
            startMs: 0,
            endMs: duration,
            confidence: 0.98,
          }),
        );
      ws.close();
    }
  });
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await pause(250);
  }
  throw new Error(`Server did not start: ${log}`);
}
try {
  await new Promise((resolve) => speechMock.listen(0, '127.0.0.1', resolve));
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--rm',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-e',
    'POSTGRES_USER=sufler',
    '-e',
    `POSTGRES_PASSWORD=${secret}`,
    '-e',
    'POSTGRES_DB=sufler',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  );
  let pgReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', name, 'pg_isready', '-U', 'sufler');
      pgReady = true;
      break;
    } catch {
      await pause(500);
    }
  }
  assert(pgReady, 'PostgreSQL readiness');
  const mapped = docker('port', name, '5432/tcp').split(':').at(-1);
  const env = {
    ...process.env,
    DEMO_MODE: 'false',
    RAG_ENABLED: 'false',
    ASSISTANCE_MODE: 'scripts',
    KNOWLEDGE_URL: 'http://127.0.0.1:1',
    SPEECH_URL: `http://127.0.0.1:${speechMock.address().port}`,
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://sufler:${secret}@127.0.0.1:${mapped}/sufler`,
    REDIS_URL: '',
    APP_ORIGIN: origin,
    HOST: '127.0.0.1',
    PORT: String(port),
    BETTER_AUTH_SECRET: secret,
    INTERNAL_SERVICE_TOKEN: secret,
    DASHSCOPE_API_KEY: '',
    AUDIO_RECORDING_ENABLED: 'false',
    BOOTSTRAP_EMAIL: `owner-${suffix}@example.test`,
    BOOTSTRAP_NAME: 'Test owner',
    BOOTSTRAP_PASSWORD: password,
    BOOTSTRAP_ORG: 'Test organization A',
  };
  const cli = (action, overrides = {}) =>
    execFileSync(process.execPath, ['apps/api/dist/cli.js', action], {
      cwd: root,
      env: { ...env, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  cli('migrate');
  cli('bootstrap');
  cli('bootstrap', {
    BOOTSTRAP_EMAIL: `other-${suffix}@example.test`,
    BOOTSTRAP_ORG: 'Test organization B',
  });
  server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  await ready(`${origin}/api/health`);
  async function call(path, { cookie = '', method = 'GET', body, requestOrigin = origin } = {}) {
    const res = await fetch(origin + path, {
      method,
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      body: await res.json(),
      cookies: res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    };
  }
  const login = async (email) => {
    const r = await call('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert(r.cookies);
    return r.cookies;
  };
  const owner = await login(env.BOOTSTRAP_EMAIL),
    other = await login(`other-${suffix}@example.test`);
  assert.equal((await call('/api/session')).status, 401);
  assert.equal((await call('/api/session', { cookie: owner })).body.role, 'owner');
  const email = `staff-${suffix}@example.test`;
  assert.equal(
    (
      await call('/api/admin/users', {
        cookie: owner,
        method: 'POST',
        body: { name: 'Test consultant', email, password, role: 'consultant' },
      })
    ).status,
    201,
  );
  const staff = await login(email);
  assert.equal((await call('/api/session', { cookie: staff })).body.role, 'consultant');
  const ownerInfo = (await call('/api/session', { cookie: owner })).body;
  voiceProfiles.add(`${ownerInfo.orgId}:${ownerInfo.id}`);
  assert.equal((await call('/api/voice-profile')).status, 401);
  assert.equal((await call('/api/voice-profile', { cookie: owner })).body.available, true);
  assert.equal((await call('/api/voice-profile', { cookie: staff })).body.available, false);
  const ownSample = await fetch(origin + '/api/voice-profile/sample', {
    headers: { Cookie: owner },
  });
  assert.equal(ownSample.status, 200);
  assert.equal(await ownSample.text(), 'RIFFsample');
  const foreignSample = await fetch(
    origin + `/api/voice-profile/sample?profileId=${ownerInfo.orgId}:${ownerInfo.id}`,
    { headers: { Cookie: staff } },
  );
  assert.notEqual(foreignSample.status, 200);
  await call('/api/voice-profile', { cookie: owner, method: 'DELETE' });
  assert.equal((await call('/api/voice-profile', { cookie: owner })).body.available, false);

  for (const path of [
    '/api/admin/users',
    '/api/admin/documents',
    '/api/admin/history',
    '/api/admin/models',
    '/api/admin/prompts',
    '/api/admin/overview',
  ])
    assert.equal((await call(path, { cookie: staff })).status, 403, path);
  assert.equal(
    (
      await call('/api/admin/users', {
        cookie: staff,
        method: 'POST',
        body: { name: 'No access', email: 'no@example.test', password, role: 'admin' },
      })
    ).status,
    403,
  );
  assert(
    (
      await call('/api/auth/sign-up/email', {
        method: 'POST',
        body: { name: 'No signup', email: 'public@example.test', password },
      })
    ).status >= 400,
  );
  const a = (await call('/api/conversations', { cookie: staff, method: 'POST', body: {} })).body;
  const b = (await call('/api/conversations', { cookie: other, method: 'POST', body: {} })).body;
  assert(a.id && b.id);
  assert.equal((await call(`/api/admin/history/${a.id}/analytics`, { cookie: staff })).status, 403);
  assert.equal((await call(`/api/admin/history/${a.id}/analytics`, { cookie: owner })).status, 200);
  assert.equal((await call(`/api/admin/history/${b.id}/analytics`, { cookie: owner })).status, 404);
  assert.equal((await call(`/api/admin/history/${a.id}/analytics`)).status, 401);

  assert.equal((await call(`/api/conversations/${b.id}`, { cookie: staff })).status, 404);
  assert.equal((await call(`/api/recordings/${b.id}/0`, { cookie: owner })).status, 404);
  assert.equal((await call(`/api/conversations/${b.id}/audio`, { cookie: owner })).status, 404);
  assert.equal((await call(`/api/conversations/${a.id}`, { cookie: other })).status, 404);
  assert.equal(
    (
      await call('/api/organizations/switch', {
        cookie: staff,
        method: 'POST',
        body: { id: b.orgId },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('/api/conversations', {
        cookie: staff,
        method: 'POST',
        body: {},
        requestOrigin: 'https://untrusted.example',
      })
    ).status,
    403,
  );
  const hint = await call(`/api/conversations/${a.id}/hint`, {
    cookie: staff,
    method: 'POST',
    body: {},
  });
  assert.equal(hint.status, 400);
  assert.match(hint.body.message, /DASHSCOPE_API_KEY/);
  const promptValues = {
    hintPrompt: 'Уточняй потребность и бюджет без давления.',
    chatPrompt: 'Помогай отвечать на возражения и уважай отказ.',
  };
  assert.equal(
    (await call('/api/admin/prompts', { cookie: staff, method: 'POST', body: promptValues }))
      .status,
    403,
  );
  const savedPrompts = await call('/api/admin/prompts', {
    cookie: owner,
    method: 'POST',
    body: promptValues,
  });
  assert.equal(savedPrompts.status, 201);
  assert.equal(
    (await call('/api/admin/prompts', { cookie: owner })).body.settings.hintPrompt,
    promptValues.hintPrompt,
  );
  assert.notEqual(
    (await call('/api/admin/prompts', { cookie: other })).body.settings.hintPrompt,
    promptValues.hintPrompt,
  );
  assert.equal(
    (await call('/api/admin/sales-templates', { cookie: staff, method: 'POST', body: {} })).status,
    403,
  );
  assert.equal(
    (await call('/api/admin/classifier/test', { cookie: staff, method: 'POST', body: {} })).status,
    403,
  );
  assert.equal(
    (await call('/api/admin/classifier/test', { cookie: owner, method: 'POST', body: {} })).status,
    400,
  );
  assert.equal(
    (
      await call('/api/admin/models', {
        cookie: owner,
        method: 'POST',
        body: { id: 'qwen/qwen3.5-9b', name: 'Legacy Qwen', enabled: true, isDefault: true },
      })
    ).status,
    201,
  );
  await call(`/api/conversations/${a.id}`, {
    cookie: staff,
    method: 'PATCH',
    body: { modelId: 'qwen/qwen3.5-9b' },
  });
  cli('migrate');
  const migratedModels = (await call('/api/admin/models', { cookie: owner })).body;
  assert(migratedModels.some((m) => m.id === 'qwen3.8-27b' && m.isDefault));
  assert(!migratedModels.some((m) => m.id === 'qwen/qwen3.5-9b'));
  assert.equal(
    (await call(`/api/conversations/${a.id}`, { cookie: staff })).body.modelId,
    'qwen3.8-27b',
  );
  cli('migrate');
  const templates = await call('/api/admin/sales-templates', {
    cookie: owner,
    method: 'POST',
    body: {},
  });
  assert.equal(templates.status, 201);
  assert.equal(templates.body.length, 2);
  const script = templates.body.find((d) => d.type === 'process');
  const published = await call(`/api/admin/documents/${script.id}/status`, {
    cookie: owner,
    method: 'POST',
    body: { status: 'published' },
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.indexedVersion, null);
  const selected = await call(`/api/conversations/${a.id}`, {
    cookie: staff,
    method: 'PATCH',
    body: { salesScriptId: script.id },
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.hints.at(-1).blocks[0].blockId, script.blocks[0].id);
  assert.equal(selected.body.hints.at(-1).inputTokens, 0);
  const advanced = await call(`/api/conversations/${a.id}`, {
    cookie: staff,
    method: 'PATCH',
    body: { completedStep: script.blocks[0].id },
  });
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.hints.at(-1).blocks[0].blockId, script.blocks[1].id);
  assert.equal(
    (
      await call(`/api/conversations/${a.id}`, {
        cookie: staff,
        method: 'PATCH',
        body: { assistanceMode: 'rag' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/api/conversations/${b.id}`, {
        cookie: other,
        method: 'PATCH',
        body: { salesScriptId: script.id },
      })
    ).status,
    400,
  );
  const wsStatus = (id, cookie, requestOrigin = origin) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?conversationId=${id}`, {
        headers: { Cookie: cookie, Origin: requestOrigin },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WebSocket timed out'));
      }, 3000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve(101);
      });
      ws.on('unexpected-response', (_, r) => {
        clearTimeout(timer);
        r.resume();
        resolve(r.statusCode);
      });
      ws.on('error', () => {});
    });
  assert.equal(await wsStatus(a.id, staff), 101);
  assert.equal(await wsStatus(b.id, staff), 401);
  assert.equal(await wsStatus(a.id, ''), 401);
  assert.equal(await wsStatus(a.id, staff, 'https://untrusted.example'), 401);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?conversationId=${a.id}`, {
      headers: { Cookie: staff, Origin: origin },
    });
    const received = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Late audio frame check timed out'));
    }, 3000);
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => {
      // Pausing during the async start must cancel the pending upstream connection.
      ws.send(JSON.stringify({ type: 'audio.start', mode: 'listen' }));
      ws.send(JSON.stringify({ type: 'audio.stop' }));
      // Simulate PCM arriving after the upstream channel has been closed.
      ws.send(Buffer.alloc(3200));
      ws.ping();
    });
    ws.once('pong', async () => {
      await pause(250);
      clearTimeout(timer);
      ws.close();
      try {
        assert.equal(
          received.some((event) => event.type === 'error'),
          false,
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  // Continuous session routing: switch and undo never restart the upstream socket.
  await pause(100);
  const work = (await call(`/api/sessions/${a.id}`, { cookie: staff })).body;
  assert.equal((await call(`/api/sessions/${a.id}`, { cookie: other })).status, 404);
  assert.equal((await call('/api/admin/metrics', { cookie: staff })).status, 403);
  assert.equal((await call('/api/admin/tariffs', { cookie: staff })).status, 403);
  const tariffBody = {
    modelId: 'qwen-test',
    input: 2,
    output: 6,
    cached: 1,
    effectiveAt: new Date().toISOString(),
  };
  assert.equal(
    (await call('/api/admin/tariffs', { cookie: owner, method: 'POST', body: tariffBody })).status,
    201,
  );
  assert.equal((await call('/api/admin/tariffs', { cookie: other })).body.length, 0);
  assert.equal((await call('/api/admin/metrics', { cookie: owner })).status, 200);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?sessionId=${work.id}`, {
      headers: { Cookie: staff, Origin: origin },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Continuous session test timed out'));
    }, 10000);
    let tested = false;
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'audio.start' })));
    ws.on('message', async (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type !== 'audio.status' || event.data.status !== 'listening' || tested) return;
      tested = true;
      try {
        const before = speechConnections;
        const frame = (seq, start) => {
          const b = Buffer.alloc(3212);
          b.writeUInt32LE(0x53554631, 0);
          b.writeUInt32LE(seq, 4);
          b.writeUInt32LE(start, 8);
          return b;
        };
        ws.send(frame(0, 0));
        await pause(100);
        const next = await call(`/api/sessions/${work.id}/next`, {
          cookie: staff,
          method: 'POST',
          body: {},
        });
        assert.equal(next.status, 201);
        assert(next.body.boundary.id);
        assert.equal(
          (
            await call(`/api/sessions/${work.id}/undo`, {
              cookie: other,
              method: 'POST',
              body: { boundaryId: next.body.boundary.id },
            })
          ).status,
          404,
        );
        ws.send(frame(1, 1600));
        await pause(100);
        const undone = await call(`/api/sessions/${work.id}/undo`, {
          cookie: staff,
          method: 'POST',
          body: { boundaryId: next.body.boundary.id },
        });
        assert.equal(undone.status, 201);
        assert.equal(undone.body.conversation.id, a.id);
        assert.equal(speechConnections, before);
        assert(speechFrames >= 2);
        ws.send(JSON.stringify({ type: 'audio.stop' }));
        const stopped = await new Promise((r) => {
          const receive = (raw) => {
            const e = JSON.parse(raw.toString());
            if (e.type === 'audio.status' && e.data.status === 'stopped') {
              ws.off('message', receive);
              r(true);
            }
          };
          ws.on('message', receive);
        });
        assert(stopped);
        const sessionAfter = (await call(`/api/sessions/${a.id}`, { cookie: staff })).body;
        assert.equal(sessionAfter.timelineMs, 200);
        clearTimeout(timer);
        ws.close();
        resolve();
      } catch (e) {
        clearTimeout(timer);
        ws.terminate();
        reject(e);
      }
    });
  });
  console.log(
    'PASS: PostgreSQL migration/bootstrap; password sign-in; no public sign-up; organization and role isolation; Origin checks; authorized/unauthorized WebSocket; prompt sales requires provider key, not knowledge; protected organization prompts; real-mode script publication without knowledge service; zero-token steps; role/tenant isolation for scripts.',
  );
} catch (e) {
  console.error(e);
  if (server) console.error(log.slice(-5000));
  process.exitCode = 1;
} finally {
  server?.kill('SIGTERM');
  for (const ws of speechSockets.clients) ws.terminate();
  speechSockets.close();
  await new Promise((resolve) => speechMock.close(resolve));
  try {
    docker('rm', '-f', name);
  } catch {}
}
