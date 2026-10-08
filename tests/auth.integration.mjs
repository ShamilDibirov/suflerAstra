// Exercises the compiled API and real Better Auth against an isolated, disposable PostgreSQL.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { WebSocket } = require('ws');
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
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://sufler:${secret}@127.0.0.1:${mapped}/sufler`,
    REDIS_URL: '',
    APP_ORIGIN: origin,
    HOST: '127.0.0.1',
    PORT: String(port),
    BETTER_AUTH_SECRET: secret,
    INTERNAL_SERVICE_TOKEN: secret,
    OPENROUTER_API_KEY: '',
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
  for (const path of [
    '/api/admin/users',
    '/api/admin/documents',
    '/api/admin/history',
    '/api/admin/models',
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
  assert.equal((await call(`/api/conversations/${b.id}`, { cookie: staff })).status, 404);
  assert.equal((await call(`/api/recordings/${b.id}/0`, { cookie: owner })).status, 404);
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
  assert.equal(hint.status, 201);
  assert.equal(hint.body.kind, 'no_evidence');
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
  console.log(
    'PASS: PostgreSQL migration/bootstrap; password sign-in; no public sign-up; organization and role isolation; Origin checks; authorized/unauthorized WebSocket; grounded empty-base refusal.',
  );
} catch (e) {
  console.error(e);
  if (server) console.error(log.slice(-5000));
  process.exitCode = 1;
} finally {
  server?.kill('SIGTERM');
  try {
    docker('rm', '-f', name);
  } catch {}
}
