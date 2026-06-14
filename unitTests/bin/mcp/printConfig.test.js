const assert = require('node:assert/strict');
const { renderConfig } = require('#src/bin/mcp/printConfig');

const BASE = {
	subcommand: 'print-config',
	profile: 'operations',
	mountPath: '/mcp',
	rejectUnauthorized: true,
	help: false,
};

describe('bin/mcp/printConfig.renderConfig', () => {
	it('claude-desktop emits an mcpServers entry calling `harper mcp`', () => {
		const block = renderConfig({ ...BASE, client: 'claude-desktop' });
		const harper = block.body.mcpServers.harper;
		assert.equal(harper.command, 'harper');
		assert.deepEqual(harper.args, ['mcp']);
		assert.match(block.target, /claude_desktop_config\.json/);
	});

	it('cursor emits mcpServers under ~/.cursor/mcp.json', () => {
		const block = renderConfig({ ...BASE, client: 'cursor' });
		assert.ok(block.body.mcpServers.harper);
		assert.match(block.target, /\.cursor\/mcp\.json/);
	});

	it('zed emits context_servers entry', () => {
		const block = renderConfig({ ...BASE, client: 'zed' });
		assert.ok(block.body.context_servers.harper);
		assert.equal(block.body.context_servers.harper.command.path, 'harper');
	});

	it('forwards non-default flags into args', () => {
		const block = renderConfig({
			...BASE,
			client: 'claude-desktop',
			profile: 'application',
			target: 'https://node:9926',
			mountPath: '/mcp2',
			username: 'alice',
			rejectUnauthorized: false,
		});
		const args = block.body.mcpServers.harper.args;
		assert.deepEqual(args, [
			'mcp',
			'--profile',
			'application',
			'--target',
			'https://node:9926',
			'--mount-path',
			'/mcp2',
			'--username',
			'alice',
			'--insecure',
		]);
	});

	it('omits --profile when it matches the default (operations)', () => {
		const block = renderConfig({ ...BASE, client: 'claude-desktop' });
		assert.deepEqual(block.body.mcpServers.harper.args, ['mcp']);
	});
});
