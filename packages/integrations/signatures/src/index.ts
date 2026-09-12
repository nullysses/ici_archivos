export interface SignaturePort {
  verify(signatureReference: string): Promise<'valid' | 'invalid' | 'unsupported'>;
}

import net from 'node:net';

export interface MalwareScanResult {
  readonly verdict: 'CLEAN' | 'INFECTED';
  readonly engine: string;
  readonly engineVersion?: string;
  readonly signatureVersion?: string;
  readonly threatName?: string;
  readonly scannedAt: Date;
}

export interface MalwareScannerPort {
  scan(body: ReadableStream<Uint8Array>): Promise<MalwareScanResult>;
}

export interface ClamdMalwareScannerOptions {
  readonly host: string;
  readonly port: number;
  readonly connectTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly engineVersion?: string;
  readonly signatureVersion?: string;
  readonly connect?: (options: { readonly host: string; readonly port: number }) => net.Socket;
}

function writeChunk(socket: net.Socket, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = Buffer.allocUnsafe(4 + chunk.byteLength);
    frame.writeUInt32BE(chunk.byteLength, 0);
    Buffer.from(chunk).copy(frame, 4);
    socket.write(frame, (error?: Error | null) => error == null ? resolve() : reject(error));
  });
}

function writeBuffer(socket: net.Socket, buffer: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(buffer, (error?: Error | null) => error == null ? resolve() : reject(error));
  });
}

/** Minimal clamd INSTREAM client with bounded framing and fail-closed errors. */
export class ClamdMalwareScanner implements MalwareScannerPort {
  public constructor(private readonly options: ClamdMalwareScannerOptions) {}

  public async scan(body: ReadableStream<Uint8Array>): Promise<MalwareScanResult> {
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 5_000;
    const readTimeoutMs = this.options.readTimeoutMs ?? 30_000;
    const socket = (this.options.connect ?? net.createConnection)({ host: this.options.host, port: this.options.port });
    socket.setTimeout(readTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ClamAV connection timed out')), connectTimeoutMs);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      const responsePromise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer) => {
          chunks.push(chunk);
          if (chunk.includes(0x0a)) { cleanup(); resolve(Buffer.concat(chunks).toString('utf8').trim()); }
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onTimeout = () => { cleanup(); reject(new Error('ClamAV response timed out')); };
        const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('timeout', onTimeout); };
        socket.on('data', onData); socket.once('error', onError); socket.once('timeout', onTimeout);
      });
      await writeBuffer(socket, Buffer.from('zINSTREAM\u0000'));
      const reader = body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          await writeChunk(socket, next.value);
        }
      } finally { reader.releaseLock(); }
      await writeBuffer(socket, Buffer.alloc(4));
      const response = await responsePromise;
      const scannedAt = new Date();
      if (/\bOK$/.test(response)) return { verdict: 'CLEAN', engine: 'clamd', ...(this.options.engineVersion === undefined ? {} : { engineVersion: this.options.engineVersion }), ...(this.options.signatureVersion === undefined ? {} : { signatureVersion: this.options.signatureVersion }), scannedAt };
      const found = response.match(/^stream:\s*(.+?)\s+FOUND$/i);
      if (found?.[1] !== undefined) return { verdict: 'INFECTED', engine: 'clamd', ...(this.options.engineVersion === undefined ? {} : { engineVersion: this.options.engineVersion }), ...(this.options.signatureVersion === undefined ? {} : { signatureVersion: this.options.signatureVersion }), threatName: found[1], scannedAt };
      throw new Error('Unknown ClamAV response');
    } finally { socket.destroy(); }
  }
}
