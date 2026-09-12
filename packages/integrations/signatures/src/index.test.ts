import { Duplex } from 'node:stream';
import type net from 'node:net';
import { describe, expect, it } from 'vitest';
import { ClamdMalwareScanner } from './index.js';

class FakeClamdSocket extends Duplex {
  public received = Buffer.alloc(0);
  public constructor(private readonly response: string, private readonly fail = false) {
    super();
    queueMicrotask(() => this.emit(this.fail ? 'error' : 'connect', this.fail ? new Error('daemon unavailable') : undefined));
  }
  public setTimeout(milliseconds: number): this { void milliseconds; return this; }
  public override _read(): void {}
  public override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void): void {
    this.received = Buffer.concat([this.received, chunk]);
    if (chunk.length >= 4 && chunk.subarray(-4).every((byte) => byte === 0)) this.push(`${this.response}\n`);
    callback();
  }
}

function scannerWithSocket(response: string, capture: (socket: FakeClamdSocket) => void, fail = false): ClamdMalwareScanner {
  return new ClamdMalwareScanner({ host: 'test', port: 3310, connect: () => {
    const socket = new FakeClamdSocket(response, fail);
    capture(socket);
    return socket as unknown as net.Socket;
  } });
}

function streamOf(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } });
}

describe('clamd INSTREAM adapter', () => {
  it('frames INSTREAM chunks and parses a clean response', async () => {
    let socket!: FakeClamdSocket;
    const result = await scannerWithSocket('stream: OK', (value) => { socket = value; }).scan(streamOf(new TextEncoder().encode('hello')));
    expect(result).toMatchObject({ verdict: 'CLEAN', engine: 'clamd' });
    expect(socket.received.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
    expect(socket.received.readUInt32BE(10)).toBe(5);
    expect(socket.received.subarray(14, 19).toString()).toBe('hello');
    expect(socket.received.readUInt32BE(19)).toBe(0);
  });

  it('parses an infected response with the threat name', async () => {
    let socket!: FakeClamdSocket;
    const result = await scannerWithSocket('stream: Eicar-Test-Signature FOUND', (value) => { socket = value; }).scan(streamOf(new Uint8Array([1, 2])));
    expect(result.verdict).toBe('INFECTED');
    expect(result.threatName).toBe('Eicar-Test-Signature');
    expect(socket.received.length).toBeGreaterThan(0);
  });

  it('fails closed on an unknown daemon response', async () => {
    await expect(scannerWithSocket('stream: UNKNOWN', () => {}).scan(streamOf(new Uint8Array([1])))).rejects.toThrow(/unknown/i);
  });

  it('fails closed when the daemon is unavailable', async () => {
    await expect(scannerWithSocket('', () => {}, true).scan(streamOf(new Uint8Array([1])))).rejects.toThrow(/unavailable/i);
  });
});
