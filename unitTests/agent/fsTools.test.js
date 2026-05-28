'use strict';

const assert = require('node:assert/strict');
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

	it('read_file returns contents inside componentsRoot', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'hello');
		const result = await readFileTool.handler({ path: join(scopes.componentsRoot, 'a.txt') }, ctx(scopes));
		assert.equal(result.content, 'hello');
	});

	it('read_file rejects paths outside scope roots', async () => {
		writeFileSync(join(scopes.root, 'outside.txt'), 'nope');
		await assert.rejects(
			readFileTool.handler({ path: join(scopes.root, 'outside.txt') }, ctx(scopes)),
			/outside the agent's read scope/
		);
	});

	it('write_file refuses writes to logDir', async () => {
		await assert.rejects(
			writeFileTool.handler({ path: join(scopes.logDir, 'evil.txt'), content: 'x' }, ctx(scopes)),
			/outside the agent's write scope/
		);
	});

	it('write_file creates parents and writes within componentsRoot', async () => {
		const target = join(scopes.componentsRoot, 'nested', 'b.txt');
		const result = await writeFileTool.handler({ path: target, content: 'x' }, ctx(scopes));
		assert.equal(result.bytesWritten, 1);
		assert.equal(readFileSync(target, 'utf8'), 'x');
	});

	it('write_file is marked destructive', () => {
		assert.equal(writeFileTool.destructive, true);
	});

	it('list_dir enumerates direct children of an allowed scope', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), '1');
		mkdirSync(join(scopes.componentsRoot, 'sub'));
		const { entries } = await listDirTool.handler({ path: scopes.componentsRoot }, ctx(scopes));
		const names = entries.map((e) => e.name).sort();
		assert.deepEqual(names, ['a.txt', 'sub']);
	});

	it('grep_files finds matches and respects maxResults', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'apple\nbanana\nApple');
		const { results } = await grepFilesTool.handler({ root: scopes.componentsRoot, pattern: 'apple' }, ctx(scopes));
		assert.equal(results.length, 2);
		assert.equal(results[0].line, 1);
	});

	it('tail_file returns the last N lines', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), 'a\nb\nc\nd\n');
		const { lines } = await tailFileTool.handler({ path: join(scopes.logDir, 'srv.log'), lines: 2 }, ctx(scopes));
		assert.deepEqual(lines, ['c', 'd']);
	});

	it('refuses paths that resolve outside scope via ..', async () => {
		const escape = join(scopes.componentsRoot, '..', '..', 'etc', 'passwd');
		await assert.rejects(readFileTool.handler({ path: escape }, ctx(scopes)), /outside the agent's read scope/);
	});

	it('write_file enforces the byte cap', async () => {
		const big = 'x'.repeat(6 * 1024 * 1024);
		await assert.rejects(
			writeFileTool.handler({ path: join(scopes.componentsRoot, 'big.txt'), content: big }, ctx(scopes)),
			/exceeds/
		);
		assert.equal(existsSync(join(scopes.componentsRoot, 'big.txt')), false);
	});
});
