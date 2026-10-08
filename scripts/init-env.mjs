import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const secret = () => randomBytes(24).toString('hex');
const postgres = secret();
const values = {
  DEMO_MODE: 'false',
  APP_ORIGIN: 'http://localhost:8080',
  POSTGRES_PASSWORD: postgres,
  DATABASE_URL: `postgresql://sufler:${postgres}@localhost:5432/sufler`,
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: secret(),
  INTERNAL_SERVICE_TOKEN: secret(),
  WEAVIATE_API_KEY: secret(),
  S3_ACCESS_KEY: 'sufler',
  S3_SECRET_KEY: secret(),
};
let template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  template = re.test(template)
    ? template.replace(re, `${key}=${value}`)
    : template + `\n${key}=${value}\n`;
}
const target = process.argv[2] || '.env.production.local';
await writeFile(target, template, { flag: 'wx', mode: 0o600 });
console.log(
  `Created ${target}. Add provider keys and bootstrap identity locally. No secrets printed.`,
);
