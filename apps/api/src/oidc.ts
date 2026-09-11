import { createRemoteJWKSet, jwtVerify, type JWSAlgorithm, type JWTVerifyGetKey } from 'jose';
import type { ApiConfig } from '@ici/config';
import type { AccessTokenVerifier } from './auth.js';

export interface OidcVerifierOptions {
  readonly keySet?: JWTVerifyGetKey;
  readonly fetchImplementation?: typeof fetch;
}

export interface VerifiedAccessToken {
  readonly issuer: string;
  readonly subject: string;
}

/**
 * jose performs signature, issuer, audience, exp, nbf, key and algorithm
 * validation. This adapter exposes only the verified identity coordinates to
 * the framework-independent authentication boundary.
 */
export class JoseAccessTokenVerifier implements AccessTokenVerifier {
  private readonly keySet: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly algorithms: JWSAlgorithm[];

  public constructor(config: { readonly issuer: string; readonly audience: string; readonly jwksUri: string }, options: OidcVerifierOptions = {}) {
    this.issuer = requireNonBlank(config.issuer, 'OIDC issuer');
    this.audience = requireNonBlank(config.audience, 'OIDC audience');
    const jwksUri = requireUrl(config.jwksUri, 'OIDC JWKS URI');
    this.algorithms = ['RS256'];
    this.keySet = options.keySet ?? createRemoteJWKSet(jwksUri);
  }

  public async verify(accessToken: string): Promise<VerifiedAccessToken> {
    if (accessToken.trim().length === 0) throw new Error('INVALID_ACCESS_TOKEN');
    const { payload } = await jwtVerify(accessToken, this.keySet, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: this.algorithms,
    });
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (subject.length === 0) throw new Error('INVALID_ACCESS_TOKEN_SUBJECT');
    return { issuer: this.issuer, subject };
  }
}

export async function createJoseAccessTokenVerifier(config: ApiConfig, options: OidcVerifierOptions = {}): Promise<JoseAccessTokenVerifier> {
  const issuer = requireNonBlank(config.oidcIssuer, 'OIDC issuer');
  const audience = requireNonBlank(config.oidcAudience, 'OIDC audience');
  let jwksUri = config.oidcJwksUri;
  if (jwksUri === undefined) {
    const discoveryUrl = requireUrl(config.oidcDiscoveryUrl, 'OIDC discovery URL');
    const fetchImplementation = options.fetchImplementation ?? fetch;
    let response: Response;
    try {
      response = await fetchImplementation(discoveryUrl);
    } catch {
      throw new Error('OIDC_DISCOVERY_FAILED');
    }
    if (!response.ok) throw new Error('OIDC_DISCOVERY_FAILED');
    let document: unknown;
    try {
      document = await response.json();
    } catch {
      throw new Error('OIDC_DISCOVERY_INVALID');
    }
    if (!isRecord(document) || document.issuer !== issuer || typeof document.jwks_uri !== 'string') throw new Error('OIDC_DISCOVERY_INVALID');
    jwksUri = document.jwks_uri;
  }
  if (config.isProduction && !isHttpsUrl(jwksUri)) throw new Error('OIDC JWKS URI must use HTTPS in production');
  return new JoseAccessTokenVerifier({ issuer, audience, jwksUri }, options);
}

function requireNonBlank(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing ${label}`);
  return value.trim();
}

function requireUrl(value: string | undefined, label: string): URL {
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing ${label}`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
