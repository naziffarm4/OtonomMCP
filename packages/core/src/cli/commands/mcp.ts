import * as path from 'node:path';
import { type McpCommandOptions, type CliRunResult, type CliAppOptions } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import { StdioMcpTransport } from '../../mcp/mcp-transport.js';
import { createAuthoritativeMcpServer } from '../../mcp/mcp-server.js';

export async function executeMcp(
  options: McpCommandOptions,
  writer: CliOutputWriter,
  _appOptions?: CliAppOptions
): Promise<CliRunResult> {
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();

  // Create authoritative transport over stdio
  const transport = new StdioMcpTransport();

  const server = createAuthoritativeMcpServer({
    transport,
    projectRoot,
  });

  if (options.verbose) {
    writer.writeError(`[aidm-mcp] Starting AIDM MCP server in ${projectRoot}...`);
  }

  await server.start();

  if (options.verbose) {
    writer.writeError(`[aidm-mcp] AIDM MCP server running with ${server.getRegisteredTools().length} tools.`);
  }

  return new Promise<CliRunResult>((resolve) => {
    let resolved = false;

    const shutdown = async (code: CliExitCode = CliExitCode.SUCCESS) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        if (server.isRunning()) {
          await server.stop();
        }
      } catch (err) {
        writer.writeError(`[aidm-mcp] Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      }
      resolve({ exitCode: code });
    };

    const onSigint = () => { void shutdown(CliExitCode.SUCCESS); };
    const onSigterm = () => { void shutdown(CliExitCode.SUCCESS); };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    server.transport.onClose(() => {
      void shutdown(CliExitCode.SUCCESS);
    });

    process.stdin.once('close', () => {
      void shutdown(CliExitCode.SUCCESS);
    });

    function cleanup() {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  });
}
