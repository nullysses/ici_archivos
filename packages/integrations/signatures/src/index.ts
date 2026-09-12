export interface SignaturePort {
  verify(signatureReference: string): Promise<'valid' | 'invalid' | 'unsupported'>;
}
