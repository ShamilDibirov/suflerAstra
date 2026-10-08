export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '127.0.0.1',
  demo: process.env.DEMO_MODE === 'true',
  origin: process.env.APP_ORIGIN || 'http://localhost:3000',
  database: process.env.DATABASE_URL || '',
  redis: process.env.REDIS_URL || '',
  openrouter: process.env.OPENROUTER_API_KEY || '',
  mistral: process.env.MISTRAL_API_KEY || '',
  classifier: process.env.KEV_MODEL || 'jaredpalmer/kev-4b',
  fallback: process.env.CLASSIFIER_FALLBACK_MODEL || 'qwen/qwen3.5-9b',
  kevThreshold: Number(process.env.KEV_CONFIDENCE_THRESHOLD || 0.85),
  speech: process.env.SPEECH_URL || 'http://127.0.0.1:8001',
  knowledge: process.env.KNOWLEDGE_URL || 'http://127.0.0.1:8002',
  internalToken: process.env.INTERNAL_SERVICE_TOKEN || '',
  weaviate: process.env.WEAVIATE_URL || 'http://127.0.0.1:8080',
  bucket: process.env.S3_BUCKET || 'sufler',
  retentionDays: 30,
};
export function validateConfig() {
  if (
    !config.demo &&
    (!config.database ||
      !process.env.BETTER_AUTH_SECRET ||
      process.env.BETTER_AUTH_SECRET.length < 32 ||
      config.internalToken.length < 32)
  ) {
    throw new Error(
      'Real mode requires DATABASE_URL, BETTER_AUTH_SECRET (32+ chars), INTERNAL_SERVICE_TOKEN (32+ chars). Use DEMO_MODE=true explicitly for local demo.',
    );
  }
  if (
    config.demo &&
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_PUBLIC_DEMO !== 'true'
  )
    throw new Error(
      'Production demo is disabled. Set ALLOW_PUBLIC_DEMO=true only for a deliberately public, disposable demo.',
    );
}
