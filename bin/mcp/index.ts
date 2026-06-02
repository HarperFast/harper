/**
 * `harper mcp` — stdio CLI for connecting an MCP host (Claude Desktop,
 * Cursor, Zed) to a running Harper instance. Dispatches to one of three
 * subcommands (bridge, print-config, doctor). With no subcommand the
 * bridge runs and stays alive until stdin closes.
 */
import { parseArgs, type McpCliOptions } from './options.ts';
import { runBridge, resolveConnection } from './client.ts';
import { emit as emitPrintConfig } from './printConfig.ts';
import { runDoctor, formatDoctorReport } from './doctor.ts';

const HELP = `
Usage: harper mcp [subcommand] [flags]

Connects an MCP host (Claude Desktop, Cursor, Zed) to a Harper instance over
the Streamable HTTP MCP transport. By default the CLI runs as a stdio bridge:
host JSON-RPC frames in on stdin, Harper responses out on stdout.

Subcommands:
  (default)         Run the stdio bridge until stdin closes.
  print-config      Emit a paste-ready config block for an MCP host.
                    Required: --client {claude-desktop,cursor,zed}.
  doctor            Connect, handshake, list tools; report OK/FAIL per step.
  help              This message.

Connection flags:
  --profile <p>     'operations' or 'application' (default: operations).
                    --profile application requires --target (the application
                    HTTP server doesn't expose a local UDS).
  --target <url>    Connect over the network instead of local UDS. Example:
                    --target https://node.example.com:9926
  --mount-path <p>  Override the MCP route mount path (default: /mcp).
  --username <u>    Basic auth username (network mode).
  --password <p>    Basic auth password (network mode).
  --bearer <token>  Bearer token (network mode). Wins over username/password.
  --insecure        Skip TLS certificate validation (network mode only).

print-config flags:
  --client <name>   claude-desktop | cursor | zed

Examples:
  harper mcp
  harper mcp doctor --target https://node.example.com:9926
  harper mcp print-config --client claude-desktop
`;

export async function runMcpCli(argv: readonly string[]): Promise<number> {
	const opts = parseArgs(argv);
	if (opts.help || opts.subcommand === 'help') {
		process.stdout.write(HELP.trim() + '\n');
		return 0;
	}
	switch (opts.subcommand) {
		case 'bridge': {
			const connection = resolveConnection(opts);
			await runBridge({ connection, mountPath: opts.mountPath });
			return 0;
		}
		case 'print-config': {
			if (!opts.client) {
				process.stderr.write('harper mcp print-config: --client is required (claude-desktop | cursor | zed)\n');
				return 1;
			}
			emitPrintConfig(opts);
			return 0;
		}
		case 'doctor': {
			const result = await runDoctor(opts);
			formatDoctorReport(result);
			return result.ok ? 0 : 1;
		}
		default: {
			process.stderr.write(`harper mcp: unknown subcommand '${opts.subcommand as string}'\n`);
			return 1;
		}
	}
}

export { parseArgs };
export type { McpCliOptions };
