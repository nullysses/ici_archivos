export type Capability =
  | 'matter.register' | 'matter.assign' | 'matter.void' | 'matter.start' | 'matter.resolve' | 'matter.reopen' | 'matter.close'
  | 'expediente.create' | 'expediente.edit_open' | 'document.version_open' | 'expediente.close' | 'expediente.reopen'
  | 'archive_transfer.prepare' | 'archive_transfer.approve' | 'archive_transfer.retry'
  | 'archival_description.correct' | 'atom_description.publish' | 'identity.manage' | 'institution.configure'
  | 'expediente_type.manage_draft' | 'expediente_type.publish' | 'records.read';

export interface Session {
  readonly userId: string;
  readonly institutionId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly institutionCapabilities: readonly Capability[];
  readonly unitCapabilities: Readonly<Record<string, readonly Capability[]>>;
}

export class ApiError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | undefined;

/** The OIDC integration owns token acquisition. Keeping the token in module
 * memory avoids introducing a second persistent browser credential store. */
export function setAccessToken(token: string | undefined): void {
  accessToken = token;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (accessToken !== undefined) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => undefined)) as { readonly error?: { readonly message?: string } } | T | undefined;
  if (!response.ok) throw new ApiError(response.status, typeof body === 'object' && body !== null && 'error' in body && body.error?.message !== undefined ? body.error.message : 'No se pudo completar la solicitud');
  return body as T;
}

export async function fetchSession(): Promise<Session | null> {
  try {
    return await apiRequest<Session>('/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  readonly timestamp: string;
  readonly dependencies: { readonly database: 'up' | 'down' };
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
  const body = (await response.json().catch(() => undefined)) as HealthResponse | { readonly error?: { readonly message?: string } } | undefined;
  if (!response.ok && response.status !== 503) throw new ApiError(response.status, typeof body === 'object' && body !== null && 'error' in body && body.error?.message !== undefined ? body.error.message : 'No se pudo consultar el estado del sistema');
  return body as HealthResponse;
}

export function canInstitution(session: Session | null | undefined, capability: Capability): boolean {
  return session?.institutionCapabilities.includes(capability) ?? false;
}

export function canInUnit(session: Session | null | undefined, capability: Capability, unitId: string): boolean {
  return canInstitution(session, capability) || session?.unitCapabilities[unitId]?.includes(capability) === true;
}

export function canAnywhere(session: Session | null | undefined, capability: Capability): boolean {
  return canInstitution(session, capability) || Object.values(session?.unitCapabilities ?? {}).some((capabilities) => capabilities.includes(capability));
}

export const can = canInstitution;
