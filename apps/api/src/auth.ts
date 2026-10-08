import { betterAuth } from 'better-auth';
import { organization, admin } from 'better-auth/plugins';
import { fromNodeHeaders } from 'better-auth/node';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { SessionUser } from '@sufler/shared';
import { config } from './config';
import { pool } from './store';

export const auth = config.demo
  ? null
  : betterAuth({
      database: pool!,
      baseURL: config.origin,
      basePath: '/api/auth',
      secret: process.env.BETTER_AUTH_SECRET,
      trustedOrigins: [config.origin],
      emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
      session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 30 },
      rateLimit: { enabled: true, window: 60, max: 60 },
      plugins: [organization({ allowUserToCreateOrganization: false }), admin()],
    });
export const demoUser: SessionUser = {
  id: 'demo-consultant',
  name: 'Александр',
  email: 'demo@sufler.local',
  role: 'owner',
  orgId: 'demo-north',
  orgName: 'Север Телеком',
  demo: true,
};
export async function session(req: IncomingMessage): Promise<SessionUser> {
  if (config.demo) return demoUser;
  const result = await auth!.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!result) throw new UnauthorizedException('Войдите в Суфлёр');
  const requested = (result.session as typeof result.session & { activeOrganizationId?: string })
    .activeOrganizationId;
  const r = await pool!.query(
    'SELECT m.role, o.id, o.name FROM member m JOIN organization o ON o.id=m."organizationId" WHERE m."userId"=$1' +
      (requested ? ' AND o.id=$2' : '') +
      ' ORDER BY o."createdAt" LIMIT 1',
    requested ? [result.user.id, requested] : [result.user.id],
  );
  if (!r.rows[0]) throw new ForbiddenException('Нет доступа к организации');
  const org = r.rows[0];
  return {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    role: org.role === 'owner' ? 'owner' : org.role === 'admin' ? 'admin' : 'consultant',
    orgId: org.id,
    orgName: org.name,
    demo: false,
  };
}
export function assertAdmin(user: SessionUser) {
  if (!['owner', 'admin'].includes(user.role))
    throw new ForbiddenException('Нужна роль администратора');
}
export function assertOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  const allowed = new Set([
    config.origin,
    ...(config.demo ? ['http://127.0.0.1:3000', 'http://localhost:3000'] : []),
  ]);
  if (!origin || !allowed.has(origin)) throw new ForbiddenException('Недопустимый Origin');
}
