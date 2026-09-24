/**
 * MCP Transport Abstraction & Implementations (Phase 8 TASK-P8-01)
 *
 * Establishes a provider-neutral transport abstraction decoupling the AIDM MCP
 * core boundary from any single concrete transport. Provides:
 * - McpTransport contract
 * - InMemoryMcpTransport for programmatic / test execution
 * - StreamMcpTransport for arbitrary Node.js duplex streams
 * - StdioMcpTransport for standard I/O communication (Claude Desktop, Cursor, ChatGPT)
 */

import { Readable, Writable } from 'node:stream';
import type { McpMessage } from './mcp-types.js';
import { isMcpRequest, isMcpNotification, isMcpResponse } from './mcp-types.js';

// ============================================================================
// 1. MCP TRANSPORT CONTRACT
// ============================================================================

export type McpMessageHandler = (message: McpMessage) => Promise<void> | void;
export type McpErrorHandler = (error: Error) => void;
export type McpCloseHandler = () => void;

export interface McpTransport {
  /**
   * Transport identifier (e.g., 'in-memory', 'stdio', 'stream').
   */
  readonly name: string;

  /**
   * Whether the transport is currently open and connected.
   */
  readonly isConnected: boolean;

  /**
   * Start listening for incoming messages on this transport.
   */
  start(): Promise<void>;

  /**
   * Send an outgoing MCP message to the peer.
   */
  send(message: McpMessage): Promise<void>;

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: McpMessageHandler): void;

  /**
   * Register an error handler.
   */
  onError(handler: McpErrorHandler): void;

  /**
   * Register a close handler.
   */
  onClose(handler: McpCloseHandler): void;

  /**
   * Close the transport and release all associated resources.
   */
  close(): Promise<void>;
}

// ============================================================================
// 2. IN-MEMORY MCP TRANSPORT
// ============================================================================

export class InMemoryMcpTransport implements McpTransport {
  readonly name = 'in-memory';
  private _connected = false;
  private messageHandlers: McpMessageHandler[] = [];
  private errorHandlers: McpErrorHandler[] = [];
  private closeHandlers: McpCloseHandler[] = [];
  readonly sentMessages: McpMessage[] = [];

  get isConnected(): boolean {
    return this._connected;
  }

  async start(): Promise<void> {
    this._connected = true;
  }

  async send(message: McpMessage): Promise<void> {
    if (!this._connected) {
      throw new Error('Cannot send message on disconnected InMemoryMcpTransport');
    }
    this.sentMessages.push(message);
  }

  onMessage(handler: McpMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: McpErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: McpCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /**
   * Simulate an incoming client message for tests or in-process callers.
   */
  async simulateClientMessage(message: McpMessage | unknown): Promise<void> {
    if (!this._connected) {
      throw new Error('Cannot simulate message on disconnected InMemoryMcpTransport');
    }
    for (const handler of this.messageHandlers) {
      await handler(message as McpMessage);
    }
  }

  /**
   * Dispatch an internal error to registered error handlers.
   */
  simulateError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    for (const handler of this.closeHandlers) {
      handler();
    }
    this.messageHandlers = [];
    this.errorHandlers = [];
    this.closeHandlers = [];
  }

  /**
   * Clear recorded sent messages without disconnecting.
   */
  clearSentMessages(): void {
    this.sentMessages.length = 0;
  }
}

// ============================================================================
// 3. STREAM MCP TRANSPORT (NDJSON Framing)
// ============================================================================

export interface StreamTransportOptions {
  readonly name?: string;
  readonly readable: NodeJS.ReadableStream;
  readonly writable: NodeJS.WritableStream;
}

export class StreamMcpTransport implements McpTransport {
  readonly name: string;
  private _connected = false;
  private readonly readable: NodeJS.ReadableStream;
  private readonly writable: NodeJS.WritableStream;
  private messageHandlers: McpMessageHandler[] = [];
  private errorHandlers: McpErrorHandler[] = [];
  private closeHandlers: McpCloseHandler[] = [];
  private buffer = '';
  private onDataBound?: (chunk: Buffer | string) => void;
  private onErrorBound?: (err: Error) => void;
  private onEndBound?: () => void;

  constructor(options: StreamTransportOptions) {
    this.name = options.name ?? 'stream';
    this.readable = options.readable;
    this.writable = options.writable;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  async start(): Promise<void> {
    if (this._connected) return;
    this._connected = true;

    this.onDataBound = (chunk: Buffer | string) => {
      this.handleChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    };

    this.onErrorBound = (err: Error) => {
      for (const h of this.errorHandlers) {
        h(err);
      }
    };

    this.onEndBound = () => {
      void this.close();
    };

    this.readable.on('data', this.onDataBound);
    this.readable.on('error', this.onErrorBound);
    this.readable.on('end', this.onEndBound);
  }

  private handleChunk(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    // Keep trailing incomplete line in buffer
    this.buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        for (const handler of this.messageHandlers) {
          try {
            void handler(parsed);
          } catch (handlerErr) {
            for (const eh of this.errorHandlers) {
              eh(handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)));
            }
          }
        }
      } catch (parseError) {
        // Synthesize parse error message
        const malformedMsg: McpMessage = {
          jsonrpc: '2.0',
          id: 0,
          method: '__malformed_json__',
          params: { raw: line, error: String(parseError) },
        };
        for (const handler of this.messageHandlers) {
          void handler(malformedMsg);
        }
      }
    }
  }

  async send(message: McpMessage): Promise<void> {
    if (!this._connected) {
      throw new Error(`Cannot send message on disconnected ${this.name} transport`);
    }

    const payload = JSON.stringify(message) + '\n';
    await new Promise<void>((resolve, reject) => {
      const ok = this.writable.write(payload, 'utf-8', (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (!ok) {
        this.writable.once('drain', resolve);
      }
    });
  }

  onMessage(handler: McpMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: McpErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: McpCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;

    if (this.onDataBound) {
      this.readable.removeListener('data', this.onDataBound);
    }
    if (this.onErrorBound) {
      this.readable.removeListener('error', this.onErrorBound);
    }
    if (this.onEndBound) {
      this.readable.removeListener('end', this.onEndBound);
    }

    for (const h of this.closeHandlers) {
      h();
    }

    this.messageHandlers = [];
    this.errorHandlers = [];
    this.closeHandlers = [];
  }
}

// ============================================================================
// 4. STDIO MCP TRANSPORT
// ============================================================================

export interface StdioTransportOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
}

export class StdioMcpTransport extends StreamMcpTransport {
  constructor(options: StdioTransportOptions = {}) {
    super({
      name: 'stdio',
      readable: options.stdin ?? process.stdin,
      writable: options.stdout ?? process.stdout,
    });
  }
}
