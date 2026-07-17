'use strict';

const assert = require('node:assert');
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readFileTool, writeFileTool, listDirTool, grepFilesTool, tailFileTool } = require('#src/agent/tools/fsTools');

function mkScopes() {
	const root = mkdtempSync(join(tmpdir(), 'agent-fs-'));
	const componentsRoot = join(root, 'components');
	const logDir = join(root, 'logs');
	const configDir = join(root, 'config');
	mkdirSync(componentsRoot);
	mkdirSync(logDir);
	mkdirSync(configDir);
	return { componentsRoot, logDir, configDir, root };
}

function ctx(scopes) {
	return { sessionId: 'sess', scopes };
}

describe('agent/fsTools', () => {
	let scopes;
	beforeEach(() => {
		scopes = mkScopes();
	});

	it('read_file returns contents from the components scope (default root)', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'hello');
		const result = await readFileTool.handler({ path: 'a.txt' }, ctx(scopes));
		assert.equal(result.content, 'hello');
	});

	it('read_file reads from the logs scope when root is specified', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), 'log line');
		const result = await readFileTool.handler({ root: 'logs', path: 'srv.log' }, ctx(scopes));
		assert.equal(result.content, 'log line');
	});

	it('read_file rejects absolute paths', async () => {
		await assert.rejects(readFileTool.handler({ path: '/etc/passwd' }, ctx(scopes)), /must be relative/);
	});

	it('read_file rejects an unknown root', async () => {
		await assert.rejects(readFileTool.handler({ root: 'secrets', path: 'a.txt' }, ctx(scopes)), /Invalid fs root/);
	});

	it('write_file refuses to escape the components scope via ..', async () => {
		await assert.rejects(
			writeFileTool.handler({ path: join('..', 'logs', 'evil.txt'), content: 'x' }, ctx(scopes)),
			/outside the agent's 'components' scope/
		);
		assert.equal(existsSync(join(scopes.logDir, 'evil.txt')), false);
	});

	it('write_file creates parents and writes within the components scope', async () => {
		const result = await writeFileTool.handler({ path: join('nested', 'b.txt'), content: 'x' }, ctx(scopes));
		assert.equal(result.bytesWritten, 1);
		assert.equal(readFileSync(join(scopes.componentsRoot, 'nested', 'b.txt'), 'utf8'), 'x');
	});

	it('write_file is marked destructive', () => {
		assert.equal(writeFileTool.destructive, true);
	});

	it('list_dir enumerates direct children of a scope (default root)', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), '1');
		mkdirSync(join(scopes.componentsRoot, 'sub'));
		const { entries } = await listDirTool.handler({}, ctx(scopes));
		const names = entries.map((e) => e.name).sort();
		assert.deepEqual(names, ['a.txt', 'sub']);
	});

	it('grep_files finds matches and respects maxResults', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'apple\nbanana\nApple');
		const { results } = await grepFilesTool.handler({ pattern: 'apple' }, ctx(scopes));
		assert.equal(results.length, 2);
		assert.equal(results[0].line, 1);
	});

	it('tail_file returns the last N lines from the logs scope', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), 'a\nb\nc\nd\n');
		const { lines } = await tailFileTool.handler({ root: 'logs', path: 'srv.log', lines: 2 }, ctx(scopes));
		assert.deepEqual(lines, ['c', 'd']);
	});

	it('grep_files refuses to traverse symlinked dirs that escape scope', async () => {
		const { symlinkSync } = require('node:fs');
		// Create an out-of-scope dir with a file, then link into componentsRoot.
		const escapeTarget = join(scopes.root, 'escape-target');
		mkdirSync(escapeTarget);
		writeFileSync(join(escapeTarget, 'secret.txt'), 'PRIVATE');
		try {
			symlinkSync(escapeTarget, join(scopes.componentsRoot, 'gateway'), 'dir');
		} catch (err) {
			// Symlink not supported (e.g. some CI envs without permission) — skip the assertion
			// rather than fail the suite. Real environments support it.
			if (err.code === 'EPERM' || err.code === 'ENOTSUP') return;
			throw err;
		}
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'PRIVATE');
		const { results } = await grepFilesTool.handler({ pattern: 'PRIVATE' }, ctx(scopes));
		// Should only find the file in componentsRoot, not the file behind the symlink.
		assert.equal(results.length, 1);
		assert.match(results[0].path, /a\.txt$/);
	});

	it('write_file refuses to write through a symlink whose target is outside scope (incl. non-existent target)', async () => {
		const { symlinkSync } = require('node:fs');
		const outsideTarget = join(scopes.root, 'outside-secret.txt'); // does NOT exist → realpath would throw
		try {
			symlinkSync(outsideTarget, join(scopes.componentsRoot, 'escape-link'), 'file');
		} catch (err) {
			if (err.code === 'EPERM' || err.code === 'ENOTSUP') return;
			throw err;
		}
		await assert.rejects(
			writeFileTool.handler({ path: 'escape-link', content: 'pwned' }, ctx(scopes)),
			/through a symlink/
		);
		assert.equal(existsSync(outsideTarget), false);
	});

	it('read_file refuses paths that resolve outside scope via ..', async () => {
		const escape = join('..', '..', 'etc', 'passwd');
		await assert.rejects(readFileTool.handler({ path: escape }, ctx(scopes)), /outside the agent's 'components' scope/);
	});

	it('write_file enforces the byte cap', async () => {
		const big = 'x'.repeat(6 * 1024 * 1024);
		await assert.rejects(writeFileTool.handler({ path: 'big.txt', content: big }, ctx(scopes)), /exceeds/);
		assert.equal(existsSync(join(scopes.componentsRoot, 'big.txt')), false);
	});
});
