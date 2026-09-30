import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ExternalMcpClientOptions {
  serverExecutable?: string;
  serverArgs?: string[];
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

export class ExternalMcpClient {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pendingRequests = new Map<string | number, {
    resolve: (res: McpJsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private nextId = 1;
  private stderrOutput = '';
  private readonly options: ExternalMcpClientOptions;
  readonly projectRoot: string;

  constructor(options: ExternalMcpClientOptions) {
    this.options = options;
    this.projectRoot = options.projectRoot;
  }


  get clientPid(): number {
    return process.pid;
  }

  get serverPid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  get stderr(): string {
    return this.stderrOutput;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error('ExternalMcpClient already started');
    }

    const execPath = this.options.serverExecutable ?? process.execPath;
    const binPath = path.resolve(import.meta.dirname, '../../bin/aidm.js');
    const args = this.options.serverArgs ?? [binPath, 'mcp', '-C', this.projectRoot];

    this.child = spawn(execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
    });

    this.child.stderr?.on('data', (chunk) => {
      this.stderrOutput += chunk.toString('utf-8');
    });

    this.child.stdout?.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as McpJsonRpcResponse;
          if (parsed.id !== undefined && parsed.id !== null && this.pendingRequests.has(parsed.id)) {
            const handler = this.pendingRequests.get(parsed.id)!;
            this.pendingRequests.delete(parsed.id);
            handler.resolve(parsed);
          }
        } catch {
          // ignore or record non-json lines
        }
      }
    });

    this.child.on('error', (err) => {
      for (const req of this.pendingRequests.values()) {
        req.reject(err);
      }
      this.pendingRequests.clear();
    });

    this.child.on('exit', (code, signal) => {
      for (const req of this.pendingRequests.values()) {
        req.reject(new Error(`Server process exited prematurely with code ${code}, signal ${signal}`));
      }
      this.pendingRequests.clear();
    });
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<McpJsonRpcResponse<T>> {
    if (!this.child || !this.child.stdin || !this.isRunning) {
      throw new Error('Server process is not running');
    }

    const id = this.nextId++;
    const req: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<McpJsonRpcResponse<T>>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (res: McpJsonRpcResponse) => void,
        reject,
      });

      const payload = JSON.stringify(req) + '\n';
      this.child!.stdin!.write(payload, 'utf-8', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  async sendRaw(raw: string): Promise<string> {
    if (!this.child || !this.child.stdin || !this.isRunning) {
      throw new Error('Server process is not running');
    }

    return new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        cleanup();
        resolve(chunk.toString('utf-8'));
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.child?.stdout?.removeListener('data', onData);
        this.child?.removeListener('error', onError);
      };

      this.child!.stdout!.once('data', onData);
      this.child!.once('error', onError);

      this.child!.stdin!.write(raw.endsWith('\n') ? raw : raw + '\n', 'utf-8');
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.child || !this.child.stdin || !this.isRunning) {
      throw new Error('Server process is not running');
    }

    const notif = {
      jsonrpc: '2.0',
      method,
      params,
    };

    return new Promise<void>((resolve, reject) => {
      this.child!.stdin!.write(JSON.stringify(notif) + '\n', 'utf-8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async stop(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    if (!this.child) {
      return { exitCode: 0, signal: null };
    }

    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }, 3000);

      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        resolve({ exitCode: code, signal });
      });

      // End stdin to signal graceful closure
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    });
  }
}
