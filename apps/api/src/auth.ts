import type { Database } from '@ici/database';
import { resolveAuthorizationContext, resolveExternalIdentity, withTenantTransaction } from '@ici/database';
import type { AuthorizationContext } from '@ici/database';

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly institutionId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly authorization: AuthorizationContext;
}

export interface AccessTokenVerifier {
  verify(accessToken: string): Promise<{ readonly issuer: string; readonly subject: string }>;
}

export class UnauthenticatedError extends Error {
  public constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** Identity is deliberately resolved by issuer+subject, never by email. */
export async function authenticateAccessToken(database: Database, verifier: AccessTokenVerifier, accessToken: string): Promise<AuthenticatedPrincipal> {
  let token: { readonly issuer: string; readonly subject: string };
  try {
    token = await verifier.verify(accessToken);
  } catch {
    throw new UnauthenticatedError();
  }
  const identity = await resolveExternalIdentity(database, token.issuer, token.subject);
  if (identity === undefined || identity.institutionStatus !== 'ACTIVE' || identity.userStatus !== 'ACTIVE') throw new UnauthenticatedError();
  const authorization = await withTenantTransaction(database, identity.institutionId, (tx) => resolveAuthorizationContext(tx, identity.institutionId, identity.userId));
  return { userId: identity.userId, institutionId: identity.institutionId, issuer: token.issuer, subject: token.subject, authorization };
}

export { createJoseAccessTokenVerifier, JoseAccessTokenVerifier } from './oidc.js';
