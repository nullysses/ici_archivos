import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedPrincipal } from './auth.js';
import { UnauthenticatedError } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal;
  }
}

export type AuthenticateRequest = (accessToken: string) => Promise<AuthenticatedPrincipal>;

export const unauthenticatedResponse = {
  error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
} as const;

export function parseBearerAuthorization(value: string | string[] | undefined): string {
  if (typeof value !== 'string') throw new UnauthenticatedError();
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  if (match?.[1] === undefined) throw new UnauthenticatedError();
  return match[1];
}

export function createAuthenticationGuard(authenticate: AuthenticateRequest) {
  return async function authenticateRequest(request: FastifyRequest, reply: FastifyReply): Promise<void | FastifyReply> {
    try {
      const token = parseBearerAuthorization(request.headers.authorization);
      request.principal = await authenticate(token);
    } catch (error) {
      if (error instanceof UnauthenticatedError) return reply.code(401).send(unauthenticatedResponse);
      throw error;
    }
  };
}

export function installAuthentication(app: FastifyInstance, authenticate: AuthenticateRequest) {
  app.decorateRequest('principal');
  return createAuthenticationGuard(authenticate);
}
