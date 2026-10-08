import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const suffix = randomUUID().slice(0, 8);
const network = `sufler-rag-test-${suffix}`;
const container = `${network}-db`;
const key = randomBytes(32).toString('hex');
const docker = (args, options = {}) => execFileSync('docker', args, { stdio: 'pipe', ...options });
try {
  docker(['network', 'create', network]);
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--memory',
    '384m',
    '-e',
    'GOMEMLIMIT=256MiB',
    '-e',
    'GOMAXPROCS=1',
    '--network',
    network,
    '-e',
    'AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false',
    '-e',
    'AUTHENTICATION_APIKEY_ENABLED=true',
    '-e',
    `AUTHENTICATION_APIKEY_ALLOWED_KEYS=${key}`,
    '-e',
    'AUTHENTICATION_APIKEY_USERS=sufler',
    '-e',
    'AUTHORIZATION_ENABLE_RBAC=true',
    '-e',
    'AUTHORIZATION_RBAC_ROOT_USERS=sufler',
    '-e',
    'DEFAULT_VECTORIZER_MODULE=none',
    '-e',
    'CLUSTER_HOSTNAME=node1',
    'cr.weaviate.io/semitechnologies/weaviate:1.39.8',
  ]);
  docker(
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--network',
      network,
      '-e',
      `WEAVIATE_URL=http://${container}:8080`,
      '-e',
      `WEAVIATE_API_KEY=${key}`,
      '-e',
      `WEAVIATE_CLASS=${process.env.WEAVIATE_TEST_CLASS || 'SuflerChunk'}`,
      '-v',
      `${resolve('tests/weaviate.integration.py')}:/test.py:ro`,
      '--entrypoint',
      'python',
      process.env.KNOWLEDGE_TEST_IMAGE || 'sufler-knowledge:test',
      '/test.py',
    ],
    { stdio: 'inherit' },
  );
} finally {
  try {
    docker(['rm', '-f', container]);
  } catch {}
  try {
    docker(['network', 'rm', network]);
  } catch {}
}
