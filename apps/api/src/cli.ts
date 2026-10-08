import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { config } from './config';
import { auth } from './auth';
import { pool, migrateApp, store } from './store';
import { MODEL_DEFAULTS } from '@sufler/shared';
import { testModel, classify } from './ai';
import { newConversation } from '@sufler/shared/engine';
import { demoDocuments } from '@sufler/shared/demo';

async function migrate() {
  if (!auth) throw new Error('Set DEMO_MODE=false and configure PostgreSQL for migrations');
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  await migrateApp();
  console.log('Better Auth and application schema are ready.');
}
async function bootstrap() {
  if (!auth || !pool) throw new Error('Bootstrap requires real mode and PostgreSQL');
  const email = process.env.BOOTSTRAP_EMAIL,
    name = process.env.BOOTSTRAP_NAME,
    password = process.env.BOOTSTRAP_PASSWORD,
    org = process.env.BOOTSTRAP_ORG;
  if (!email || !name || !password || password.length < 12 || !org)
    throw new Error(
      'Provide BOOTSTRAP_EMAIL, BOOTSTRAP_NAME, BOOTSTRAP_PASSWORD (12+), BOOTSTRAP_ORG. Credentials are never printed.',
    );
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) throw new Error('Account already exists. Bootstrap does not overwrite accounts.');
  const user = await ctx.internalAdapter.createUser(
    { name, email, emailVerified: true },
    { method: 'admin' },
  );
  try {
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await ctx.password.hash(password),
    });
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,$2,$3,now())',
        [id, org, `org-${id}`],
      );
      await client.query(
        'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,\'owner\',now())',
        [randomUUID(), id, user.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    for (const model of MODEL_DEFAULTS) await store.put(id, 'model', model.id, model);
    console.log(
      'Owner and organization created. Sign in at /admin/login. Upload and publish your real knowledge base.',
    );
  } catch (e) {
    await ctx.internalAdapter.deleteUser(user.id);
    throw e;
  }
}
async function evaluate() {
  if (config.demo)
    throw new Error('Evaluation of real models requires DEMO_MODE=false and OPENROUTER_API_KEY');
  const split = process.argv[3] || 'test';
  const mode = process.argv[4] || 'pipeline';
  if (!['calibration', 'test'].includes(split) || !['pipeline', 'kev', 'qwen'].includes(mode))
    throw new Error('Usage: eval [calibration|test] [pipeline|kev|qwen]');
  const allCases = JSON.parse(
    await readFile(
      new URL(
        import.meta.url.includes('/dist/') ? './eval/ru-cases.json' : '../../../eval/ru-cases.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { id: string; text: string; direction: string; intent: string; split: string }[];
  const cases = allCases.filter((c) => c.split === split);
  const docs = demoDocuments('evaluation');
  let correct = 0;
  let fallbacks = 0;
  const latencies: number[] = [];
  for (const sample of cases) {
    const c = newConversation('evaluation', 'evaluation', config.fallback, sample.id);
    c.segments = [
      {
        id: sample.id,
        role: 'customer',
        speakerId: 'fixture',
        text: sample.text,
        startMs: 0,
        endMs: 1000,
        confidence: 1,
        final: true,
        excluded: false,
        createdAt: new Date().toISOString(),
      },
    ];
    const start = Date.now();
    const r = await classify(
      c,
      docs,
      new AbortController().signal,
      mode as 'pipeline' | 'kev' | 'qwen',
    );
    const ok = r.patch.intent === sample.intent && r.patch.direction === sample.direction;
    correct += Number(ok);
    fallbacks += Number(r.source === 'qwen');
    latencies.push(Date.now() - start);
    console.log(
      JSON.stringify({
        id: sample.id,
        split: sample.split,
        ok,
        source: r.source,
        intent: r.patch.intent,
        direction: r.patch.direction,
        confidence: r.patch.confidence,
        latencyMs: latencies.at(-1),
      }),
    );
  }
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode,
      split,
      count: cases.length,
      accuracy: correct / cases.length,
      fallbacks,
      p95: latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)],
      note: 'Small synthetic regression set; not proof of pilot quality. Calibrate on separate representative recordings.',
    }),
  );
}
async function check() {
  if (config.demo) {
    console.log('DEMO_MODE=true: no external provider requests.');
    return;
  }
  for (const m of MODEL_DEFAULTS) {
    try {
      await testModel(m.id);
      console.log(`${m.id}: OK`);
    } catch (e) {
      console.log(`${m.id}: ${e instanceof Error ? e.message : 'failed'}`);
      process.exitCode = 1;
    }
  }
  for (const [name, url] of [
    ['speech', config.speech],
    ['knowledge', config.knowledge],
  ]) {
    try {
      const r = await fetch(`${url}/health`, {
        headers: { 'X-Internal-Token': config.internalToken },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`${name}: ${r.status}`);
      if (!r.ok) process.exitCode = 1;
    } catch {
      console.log(`${name}: unavailable`);
      process.exitCode = 1;
    }
  }
}
const action = process.argv[2];
try {
  if (action === 'migrate') await migrate();
  else if (action === 'bootstrap') await bootstrap();
  else if (action === 'eval') await evaluate();
  else if (action === 'check') await check();
  else throw new Error('Usage: cli migrate|bootstrap|eval|check');
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
