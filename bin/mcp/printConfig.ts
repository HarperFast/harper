/**
 * Emit a paste-ready config block for each supported MCP client. Output
 * goes to stdout so the user can pipe or copy directly into their
 * client's config file.
 */
import type { McpCliOptions } from './options.ts';

interface ConfigBlock {
	target: string;
	body: object;
	notes: readonly string[];
}

export function renderConfig(opts: McpCliOptions): ConfigBlock {
	const client = opts.client ?? 'claude-desktop';
	const args = ['mcp'];
	// Default is 'operations'; only emit the flag when overriding to 'application'.
	if (opts.profile !== 'operations') args.push('--profile', opts.profile);
	if (opts.target) args.push('--target', opts.target);
	if (opts.mountPath !== '/mcp') args.push('--mount-path', opts.mountPath);
	if (opts.username) args.push('--username', opts.username);
	if (opts.password) args.push('--password', opts.password);
	if (opts.bearer) args.push('--bearer', opts.bearer);
	if (!opts.rejectUnauthorized) args.push('--insecure');

	switch (client) {
		case 'claude-desktop': {
			return {
				target:
					'~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows)',
				body: {
					mcpServers: {
						harper: {
							command: 'harper',
							args,
						},
					},
				},
				notes: [
					'Restart Claude Desktop after editing the file.',
					'Merge into an existing `mcpServers` block if you already have one.',
				],
			};
		}
		case 'cursor': {
			return {
				target: '~/.cursor/mcp.json',
				body: {
					mcpServers: {
						harper: {
							command: 'harper',
							args,
						},
					},
				},
				notes: ['Cursor reads this file at startup; restart after editing.'],
			};
		}
		case 'zed': {
			return {
				target: 'Zed settings.json',
				body: {
					context_servers: {
						harper: {
							command: {
								path: 'harper',
								args,
								env: {},
							},
						},
					},
				},
				notes: ["Zed's MCP support is behind a feature flag — see the Zed docs for activation."],
			};
		}
		default:
			throw new Error(`harper mcp print-config: unknown --client '${client as string}'`);
	}
}

export function emit(opts: McpCliOptions, stdout: NodeJS.WritableStream = process.stdout): void {
	const block = renderConfig(opts);
	stdout.write(`# Target file: ${block.target}\n`);
	stdout.write(JSON.stringify(block.body, null, 2));
	stdout.write('\n');
	for (const note of block.notes) {
		stdout.write(`# Note: ${note}\n`);
	}
}
