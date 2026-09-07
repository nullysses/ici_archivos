export type EntityId = string & { readonly __brand: 'EntityId' };
export type InstitutionId = string & { readonly __brand: 'InstitutionId' };

export interface DomainEvent<TPayload extends object = object> {
  readonly aggregateId: EntityId;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<TPayload>;
}

