export interface DocumentStoragePort {
  put(input: { body: ReadableStream<Uint8Array>; key: string }): Promise<void>;
  remove(key: string): Promise<void>;
}

