'use strict';

const assert = require('node:assert');
const {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	existsSync,
	realpathSync,
	rmSync,
	symlinkSync,
} = require('node:fs');
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
	return { componentsRoot, logDir, configDir, keyDirs: [join(root, 'keys')], root };
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

describe('agent/fsTools pages', () => {
	let scopes;
	beforeEach(() => {
		scopes = mkScopes();
	});

	function pagedCtx(maxResultBytes) {
		return { sessionId: 'sess', scopes, maxResultBytes };
	}

	function numberedLines(count, width = 20) {
		let text = '';
		for (let i = 1; i <= count; i++) text += `line ${String(i).padStart(width - 6, '0')}\n`;
		return text;
	}

	it('read_file returns a small file byte for byte, with its line count', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'one\r\ntwo\nthree');
		const result = await readFileTool.handler({ path: 'a.txt' }, pagedCtx(65536));
		assert.equal(result.content, 'one\r\ntwo\nthree');
		assert.deepEqual(
			{
				startLine: result.startLine,
				endLine: result.endLine,
				totalLines: result.totalLines,
				nextLine: result.nextLine,
			},
			{ startLine: 1, endLine: 3, totalLines: 3, nextLine: undefined }
		);
	});

	it('read_file pages a file through nextLine/nextOffset until totalLines, reassembling it exactly', async () => {
		const text = numberedLines(500);
		writeFileSync(join(scopes.logDir, 'big.log'), text);
		const pages = [];
		let cursor = {};
		for (;;) {
			const page = await readFileTool.handler({ root: 'logs', path: 'big.log', ...cursor }, pagedCtx(2048));
			assert.ok(Buffer.byteLength(page.content) <= 1024, `page of ${Buffer.byteLength(page.content)} bytes`);
			assert.ok(page.content.endsWith('\n'));
			pages.push(page);
			if (!page.nextLine) break;
			assert.equal(page.nextLine, page.endLine + 1);
			assert.equal(page.nextOffset, page.offset + Buffer.byteLength(page.content));
			const rescanned = await readFileTool.handler(
				{ root: 'logs', path: 'big.log', startLine: page.nextLine },
				pagedCtx(2048)
			);
			cursor = { startLine: page.nextLine, offset: page.nextOffset };
			const resumed = await readFileTool.handler({ root: 'logs', path: 'big.log', ...cursor }, pagedCtx(2048));
			assert.deepEqual(resumed, rescanned);
		}
		assert.ok(pages.length > 5);
		assert.equal(pages.map((page) => page.content).join(''), text);
		assert.equal(pages.at(-1).totalLines, 500);
		assert.equal(pages.at(-1).endLine, 500);
	});

	it('read_file from an offset alone returns content without line numbers', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'one\ntwo\nthree\n');
		const result = await readFileTool.handler({ path: 'a.txt', offset: 4 }, pagedCtx(65536));
		assert.equal(result.content, 'two\nthree\n');
		assert.equal(result.offset, 4);
		assert.equal(result.startLine, undefined);
		assert.equal(result.totalLines, undefined);
		assert.equal(result.nextOffset, undefined);
		await assert.rejects(
			readFileTool.handler({ path: 'a.txt', offset: 15 }, pagedCtx(65536)),
			/past the end of the file \(14 bytes\)/
		);
	});

	it('read_file sizes a page by its JSON-escaped length, so the loop never cuts it', async () => {
		const { serializeToolResult } = require('#src/resources/models/agentLoop');
		const line = `${'\u0001"'.repeat(20)}\n`;
		writeFileSync(join(scopes.logDir, 'ctl.log'), line.repeat(200));
		const page = await readFileTool.handler({ root: 'logs', path: 'ctl.log' }, pagedCtx(2048));
		assert.ok(page.nextLine > 2);
		assert.ok(Buffer.byteLength(JSON.stringify(page.content)) <= 1024 + 2);
		assert.equal(serializeToolResult({ ok: true, result: page }, 2048).truncated, false);
	});

	it('read_file honors lineCount and reads files over the old 5 MiB limit', async () => {
		writeFileSync(join(scopes.logDir, 'huge.log'), numberedLines(300_000));
		const result = await readFileTool.handler(
			{ root: 'logs', path: 'huge.log', startLine: 299_998, lineCount: 2 },
			pagedCtx(65536)
		);
		assert.ok(result.size > 5 * 1024 * 1024);
		assert.equal(result.content, 'line 00000000299998\nline 00000000299999\n');
		assert.equal(result.nextLine, 300_000);
		assert.equal(result.totalLines, undefined);
	});

	it('read_file past the end returns no content and the line count', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'a\nb\n');
		const atEnd = await readFileTool.handler({ path: 'a.txt', startLine: 3 }, pagedCtx(65536));
		assert.deepEqual({ content: atEnd.content, totalLines: atEnd.totalLines }, { content: '', totalLines: 2 });
		const beyond = await readFileTool.handler({ path: 'a.txt', startLine: 50 }, pagedCtx(65536));
		assert.deepEqual({ content: beyond.content, totalLines: beyond.totalLines }, { content: '', totalLines: 2 });
		writeFileSync(join(scopes.componentsRoot, 'empty.txt'), '');
		const empty = await readFileTool.handler({ path: 'empty.txt' }, pagedCtx(65536));
		assert.deepEqual({ content: empty.content, totalLines: empty.totalLines }, { content: '', totalLines: 0 });
	});

	it('keeps a whole result, cursor included, under the minimum cap even with a long path', async () => {
		const { serializeToolResult } = require('#src/resources/models/agentLoop');
		const deep = join('d'.repeat(120), 'e'.repeat(120), 'f'.repeat(120));
		mkdirSync(join(scopes.logDir, deep), { recursive: true });
		writeFileSync(join(scopes.logDir, deep, 'srv.log'), numberedLines(200));
		const read = await readFileTool.handler({ root: 'logs', path: join(deep, 'srv.log') }, pagedCtx(1024));
		const tail = await tailFileTool.handler({ root: 'logs', path: join(deep, 'srv.log') }, pagedCtx(1024));
		const grep = await grepFilesTool.handler({ root: 'logs', path: deep, pattern: 'line' }, pagedCtx(1024));
		assert.ok(read.path.length > 400);
		assert.ok(read.nextLine > 1);
		for (const result of [read, tail, grep]) {
			assert.equal(serializeToolResult({ ok: true, result }, 1024).truncated, false);
		}
	});

	it('read_file returns a line longer than a page in parts, on character boundaries, losing nothing', async () => {
		const longLine = `${'漢'.repeat(1000)}${'\u0002'.repeat(300)}end\n`;
		writeFileSync(join(scopes.componentsRoot, 'bundle.js'), `${longLine}next\n`);
		const parts = [];
		let cursor = {};
		for (;;) {
			const page = await readFileTool.handler({ path: 'bundle.js', ...cursor }, pagedCtx(2048));
			assert.ok(Buffer.byteLength(JSON.stringify(page.content)) <= 1024 + 2);
			assert.ok(!page.content.includes('\uFFFD'));
			parts.push(page);
			if (!page.lineTruncated) break;
			assert.equal(page.startLine, 1);
			assert.equal(page.nextLine, 1);
			cursor = { startLine: page.nextLine, offset: page.nextOffset };
		}
		assert.ok(parts.length > 3);
		assert.equal(parts.map((page) => page.content).join(''), `${longLine}next\n`);
		assert.equal(parts.at(-1).endLine, 2);
		assert.equal(parts.at(-1).totalLines, 2);
	});

	it('read_file rejects a startLine, lineCount or offset out of range', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'a\n');
		for (const args of [{ startLine: 0 }, { startLine: 1.5 }, { startLine: '2' }, { lineCount: -1 }, { offset: -1 }]) {
			await assert.rejects(
				readFileTool.handler({ path: 'a.txt', ...args }, pagedCtx(65536)),
				/must be an integer of at least/
			);
		}
	});

	it('read_file without a cap on the context uses 32 KiB pages', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), numberedLines(5000));
		const result = await readFileTool.handler({ path: 'a.txt' }, ctx(scopes));
		assert.ok(Buffer.byteLength(result.content) <= 32 * 1024);
		assert.ok(Buffer.byteLength(JSON.stringify(result.content)) > 31 * 1024);
		assert.equal(result.nextLine, result.endLine + 1);
	});

	it('tail_file returns only the lines that fit in a page and says so', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), numberedLines(1000));
		const result = await tailFileTool.handler({ root: 'logs', path: 'srv.log', lines: 5000 }, pagedCtx(2048));
		assert.equal(result.truncated, true);
		assert.ok(result.lines.length > 10 && result.lines.length < 60);
		assert.equal(result.lines.at(-1), 'line 00000000001000');
		assert.ok(Buffer.byteLength(result.lines.join('\n')) <= 1024);
	});

	it('tail_file is not truncated when every requested line fits', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), numberedLines(1000));
		const result = await tailFileTool.handler({ root: 'logs', path: 'srv.log', lines: 3 }, pagedCtx(65536));
		assert.deepEqual(result.lines, ['line 00000000000998', 'line 00000000000999', 'line 00000000001000']);
		assert.equal(result.truncated, false);
	});

	it('tail_file returns the cut end of a last line longer than a page', async () => {
		writeFileSync(join(scopes.logDir, 'one.log'), `start${'é'.repeat(5000)}end\n`);
		const result = await tailFileTool.handler({ root: 'logs', path: 'one.log', lines: 1 }, pagedCtx(2048));
		assert.equal(result.truncated, true);
		assert.equal(result.lines.length, 1);
		assert.match(result.lines[0], /^é+end$/);
		assert.ok(Buffer.byteLength(result.lines[0]) <= 1024);
	});

	it('tail_file rejects a lines value that is not a positive integer', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), 'a\n');
		await assert.rejects(
			tailFileTool.handler({ root: 'logs', path: 'srv.log', lines: 0 }, pagedCtx(65536)),
			/must be an integer of at least 1/
		);
	});

	it('grep_files stops at a page of results, cuts long lines, and says it stopped', async () => {
		writeFileSync(join(scopes.logDir, 'srv.log'), `${'error '.repeat(200)}\n${'error here\n'.repeat(500)}`);
		const result = await grepFilesTool.handler({ root: 'logs', pattern: 'error' }, pagedCtx(4096));
		assert.equal(result.truncated, true);
		assert.ok(result.count < 500);
		assert.equal(result.results[0].text.length, 501);
		assert.ok(result.results[0].text.endsWith('…'));
		assert.ok(Buffer.byteLength(JSON.stringify(result.results)) <= 2048);
	});

	it('tail_file keeps its JSON-escaped lines within a page', async () => {
		writeFileSync(join(scopes.logDir, 'ctl.log'), `${'\u0001'.repeat(40)}\n`.repeat(200));
		const result = await tailFileTool.handler({ root: 'logs', path: 'ctl.log', lines: 5000 }, pagedCtx(2048));
		assert.equal(result.truncated, true);
		assert.ok(result.lines.length > 1);
		assert.ok(Buffer.byteLength(JSON.stringify(result.lines)) <= 1024 + 2 * result.lines.length + 2);
		const oneLine = await tailFileTool.handler({ root: 'logs', path: 'ctl.log', lines: 1 }, pagedCtx(2048));
		assert.deepEqual(oneLine, { path: oneLine.path, lines: ['\u0001'.repeat(40)], truncated: false });
	});

	it('tail_file of a small file is not truncated', async () => {
		writeFileSync(join(scopes.logDir, 'small.log'), 'a\nb\n');
		const result = await tailFileTool.handler({ root: 'logs', path: 'small.log', lines: 10 }, pagedCtx(65536));
		assert.deepEqual(result.lines, ['a', 'b']);
		assert.equal(result.truncated, false);
	});

	it('grep_files says it stopped when maxResults left matches unreturned, and only then', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'hit\nhit\nhit\n');
		const capped = await grepFilesTool.handler({ pattern: 'hit', maxResults: 2 }, pagedCtx(65536));
		assert.equal(capped.count, 2);
		assert.equal(capped.truncated, true);
		const exact = await grepFilesTool.handler({ pattern: 'hit', maxResults: 3 }, pagedCtx(65536));
		assert.equal(exact.count, 3);
		assert.equal(exact.truncated, false);
	});

	it('grep_files does not split a surrogate pair when it cuts a line', async () => {
		writeFileSync(join(scopes.componentsRoot, 'emoji.txt'), `${'a'.repeat(499)}${'😀'.repeat(10)}\n`);
		const result = await grepFilesTool.handler({ pattern: 'a' }, pagedCtx(65536));
		assert.equal(result.results[0].text, `${'a'.repeat(499)}…`);
	});

	it('grep_files returns a first match too long for the page cut to fit, not an empty result', async () => {
		const { serializeToolResult } = require('#src/resources/models/agentLoop');
		writeFileSync(join(scopes.componentsRoot, 'cjk.txt'), `${'漢'.repeat(600)}\n漢\n`);
		const result = await grepFilesTool.handler({ pattern: '漢' }, pagedCtx(1024));
		assert.equal(result.count, 1);
		assert.equal(result.truncated, true);
		assert.match(result.results[0].text, /^漢+$/);
		assert.equal(serializeToolResult({ ok: true, result }, 1024).truncated, false);
	});

	it('grep_files counts the files it skips for being over 5 MiB', async () => {
		writeFileSync(join(scopes.logDir, 'huge.log'), 'error\n'.repeat(1_000_000));
		writeFileSync(join(scopes.logDir, 'small.log'), 'fine\n');
		const result = await grepFilesTool.handler({ root: 'logs', pattern: 'error' }, pagedCtx(65536));
		assert.deepEqual(
			{ count: result.count, truncated: result.truncated, skippedFiles: result.skippedFiles },
			{
				count: 0,
				truncated: false,
				skippedFiles: 1,
			}
		);
	});

	it('grep_files is not truncated when every match fits', async () => {
		writeFileSync(join(scopes.componentsRoot, 'a.txt'), 'apple\nbanana\nApple');
		const result = await grepFilesTool.handler({ pattern: 'apple' }, pagedCtx(65536));
		assert.equal(result.truncated, false);
		assert.equal(result.count, 2);
	});
});

describe('agent/fsTools key material and the single-file config scope (harper#3041)', () => {
	const PEM = '-----BEGIN PRIVATE KEY-----\nMIIfakekeybody\n-----END PRIVATE KEY-----\n';
	let root;

	// The default-install layout: the config file sits in rootPath beside keys/, ssh/ and database/.
	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-root-')));
		writeFileSync(join(root, 'harper-config.yaml'), 'http:\n  port: 9926\n');
		mkdirSync(join(root, 'keys'));
		writeFileSync(join(root, 'keys', 'privateKey.pem'), PEM);
		writeFileSync(join(root, 'keys', '.jwtPass'), 'secret-pass');
		writeFileSync(join(root, 'keys', 'notes.txt'), 'secret in keys dir');
		mkdirSync(join(root, 'ssh'));
		writeFileSync(join(root, 'ssh', 'deploy_id'), 'secret ssh key');
		mkdirSync(join(root, 'database'));
		writeFileSync(join(root, 'database', 'data.txt'), 'port secret row');
		mkdirSync(join(root, 'components', 'app'), { recursive: true });
		writeFileSync(join(root, 'components', 'app', 'server.key'), 'secret key bytes');
		writeFileSync(join(root, 'components', 'app', 'config.yaml'), `tls:\n  privateKey: |\n${PEM}`);
		writeFileSync(join(root, 'components', 'app', 'resource.js'), '// secret plain source');
		mkdirSync(join(root, 'log'));
	});

	const keyDirs = () => [join(root, 'keys'), join(root, 'ssh')];
	const defaultScopes = () => ({
		componentsRoot: join(root, 'components'),
		logDir: join(root, 'log'),
		configDir: root,
		configFile: 'harper-config.yaml',
		keyDirs: keyDirs(),
	});
	// Every scope widened to rootPath, as an operator could with componentsScope/configScope.
	const widenedScopes = () => ({ componentsRoot: root, logDir: root, configDir: root, keyDirs: keyDirs() });

	describe('default config scope: the config file only', () => {
		it('list_dir lists only the config file', async () => {
			const { entries } = await listDirTool.handler({ root: 'config' }, ctx(defaultScopes()));
			assert.deepEqual(entries, [{ name: 'harper-config.yaml', kind: 'file' }]);
		});

		it('read_file reads the config file by name, or with no path', async () => {
			const byName = await readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(defaultScopes()));
			assert.match(byName.content, /port: 9926/);
			const byRoot = await readFileTool.handler({ root: 'config' }, ctx(defaultScopes()));
			assert.equal(byRoot.content, byName.content);
		});

		it('refuses everything else in the config directory with a policy error, not ENOENT', async () => {
			for (const path of ['keys/privateKey.pem', 'keys/missing.pem', 'database/data.txt', 'log']) {
				await assert.rejects(
					readFileTool.handler({ root: 'config', path }, ctx(defaultScopes())),
					/outside the agent's 'config' scope/
				);
			}
			await assert.rejects(
				listDirTool.handler({ root: 'config', path: 'keys' }, ctx(defaultScopes())),
				/outside the agent's 'config' scope/
			);
		});

		it('grep_files searches the config file alone, never the directory around it', async () => {
			const { results } = await grepFilesTool.handler({ root: 'config', pattern: 'port' }, ctx(defaultScopes()));
			assert.deepEqual(
				results.map((r) => r.path),
				[join(root, 'harper-config.yaml')]
			);
		});

		it('never enumerates the config file once it has been swapped for a directory', async () => {
			rmSync(join(root, 'harper-config.yaml'));
			mkdirSync(join(root, 'harper-config.yaml'));
			writeFileSync(join(root, 'harper-config.yaml', 'inner.txt'), 'port secret');
			const listed = await listDirTool.handler({ root: 'config' }, ctx(defaultScopes()));
			assert.deepEqual(listed.entries, []);
			const grepped = await grepFilesTool.handler({ root: 'config', pattern: 'port' }, ctx(defaultScopes()));
			assert.equal(grepped.count, 0);
		});

		it('reports an unavailable config scope instead of reading anything', async () => {
			const scopes = { ...defaultScopes(), configDir: undefined, configFile: undefined };
			await assert.rejects(
				readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes)),
				/'config' scope is unavailable/
			);
		});
	});

	describe('key material is refused in every scope', () => {
		for (const scope of ['components', 'logs', 'config']) {
			it(`refuses key directories and key file names in the '${scope}' scope`, async () => {
				const c = ctx(widenedScopes());
				for (const path of ['keys/privateKey.pem', 'keys/notes.txt', 'keys/missing.txt', 'ssh/deploy_id']) {
					await assert.rejects(readFileTool.handler({ root: scope, path }, c), /Refusing to read key material/);
				}
				await assert.rejects(
					tailFileTool.handler({ root: scope, path: 'keys/.jwtPass' }, c),
					/Refusing to read key material/
				);
				await assert.rejects(listDirTool.handler({ root: scope, path: 'keys' }, c), /Refusing to read key material/);
				await assert.rejects(listDirTool.handler({ root: scope, path: 'ssh' }, c), /Refusing to read key material/);
				await assert.rejects(
					readFileTool.handler({ root: scope, path: 'components/app/server.key' }, c),
					/Refusing to read key material/
				);
				await assert.rejects(
					grepFilesTool.handler({ root: scope, path: 'keys', pattern: 'secret' }, c),
					/Refusing to read key material/
				);
			});
		}

		it('grep_files skips key directories, key file names and files holding a PEM private key', async () => {
			const { results } = await grepFilesTool.handler(
				{ root: 'config', pattern: 'secret|PRIVATE' },
				ctx(widenedScopes())
			);
			assert.deepEqual(results.map((r) => r.path).sort(), [
				join(root, 'components', 'app', 'resource.js'),
				join(root, 'database', 'data.txt'),
			]);
		});

		it('grep_files searches a file path directly', async () => {
			const { results } = await grepFilesTool.handler(
				{ path: 'app/resource.js', pattern: 'secret' },
				ctx(defaultScopes())
			);
			assert.equal(results.length, 1);
		});

		it('read_file refuses a file whose text holds a PEM private key', async () => {
			await assert.rejects(
				readFileTool.handler({ path: 'app/config.yaml' }, ctx(defaultScopes())),
				/app\/config\.yaml holds a PEM private key/
			);
		});

		it('tail_file refuses lines that hold a PEM private key, and returns lines after one', async () => {
			writeFileSync(join(root, 'log', 'hdb.log'), `start\n${PEM}line a\nline b\n`);
			await assert.rejects(
				tailFileTool.handler({ root: 'logs', path: 'hdb.log', lines: 3 }, ctx(defaultScopes())),
				/holds a PEM private key/
			);
			const { lines } = await tailFileTool.handler({ root: 'logs', path: 'hdb.log', lines: 2 }, ctx(defaultScopes()));
			assert.deepEqual(lines, ['line a', 'line b']);
		});

		it('write_file refuses a key directory, but not a key file name elsewhere', async () => {
			const c = ctx(widenedScopes());
			await assert.rejects(
				writeFileTool.handler({ path: 'keys/privateKey.pem', content: 'replaced' }, c),
				/Refusing to write key material/
			);
			assert.equal(readFileSync(join(root, 'keys', 'privateKey.pem'), 'utf8'), PEM);
			await writeFileTool.handler({ path: 'components/app/ca.pem', content: 'cert' }, c);
			assert.equal(readFileSync(join(root, 'components', 'app', 'ca.pem'), 'utf8'), 'cert');
		});

		it('compares canonical paths, so a scope reached through a symlinked root still refuses keys', async () => {
			const linkedRoot = join(mkdtempSync(join(tmpdir(), 'agent-link-')), 'harper');
			try {
				symlinkSync(root, linkedRoot, 'dir');
			} catch (err) {
				if (err.code === 'EPERM' || err.code === 'ENOTSUP') return;
				throw err;
			}
			// Key directories named through the link, as a symlinked rootPath would name them.
			const scopes = {
				componentsRoot: root,
				logDir: root,
				configDir: root,
				keyDirs: [join(linkedRoot, 'keys'), join(linkedRoot, 'ssh')],
			};
			await assert.rejects(
				readFileTool.handler({ path: 'keys/notes.txt' }, ctx(scopes)),
				/Refusing to read key material/
			);
		});

		it('follows a key directory that becomes a link after the scopes were fixed', async () => {
			const scopes = widenedScopes();
			rmSync(join(root, 'ssh'), { recursive: true });
			mkdirSync(join(root, 'components', 'ssh-store'));
			writeFileSync(join(root, 'components', 'ssh-store', 'deploy_id'), 'secret ssh key');
			try {
				symlinkSync(join(root, 'components', 'ssh-store'), join(root, 'ssh'), 'dir');
			} catch (err) {
				if (err.code === 'EPERM' || err.code === 'ENOTSUP') return;
				throw err;
			}
			await assert.rejects(
				readFileTool.handler({ path: 'components/ssh-store/deploy_id' }, ctx(scopes)),
				/Refusing to read key material/
			);
			await assert.rejects(
				writeFileTool.handler({ path: 'components/ssh-store/new_id', content: 'x' }, ctx(scopes)),
				/Refusing to write key material/
			);
		});

		it('tail_file refuses a file that ends inside a private key, even when no armor line is returned', async () => {
			writeFileSync(join(root, 'log', 'hdb.log'), 'start\n-----BEGIN PRIVATE KEY-----\nMIIbodyone\nMIIbodytwo\n');
			await assert.rejects(
				tailFileTool.handler({ root: 'logs', path: 'hdb.log', lines: 1 }, ctx(defaultScopes())),
				/ends inside a PEM private key/
			);
		});

		it('tail_file still sees a BEGIN line that lies before its read window', async () => {
			// 40 KiB of body: past the 32 KiB page, inside the 32 KiB look-back before it.
			const body = `${'A'.repeat(63)}\n`.repeat(640);
			writeFileSync(join(root, 'log', 'hdb.log'), `start\n-----BEGIN PRIVATE KEY-----\n${body}`);
			await assert.rejects(
				tailFileTool.handler({ root: 'logs', path: 'hdb.log', lines: 5 }, ctx(defaultScopes())),
				/ends inside a PEM private key/
			);
		});

		it('read_file refuses a page that lies inside a key body, though the page holds no armor line', async () => {
			const body = `${'A'.repeat(63)}\n`.repeat(40);
			writeFileSync(
				join(root, 'log', 'hdb.log'),
				`start\n-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\nafter the key\n`
			);
			const small = { ...ctx(defaultScopes()), maxResultBytes: 1024 };
			for (const cursor of [{ startLine: 20 }, { offset: 6 + 28 + 64 * 10 }]) {
				await assert.rejects(
					readFileTool.handler({ root: 'logs', path: 'hdb.log', lineCount: 3, ...cursor }, small),
					/holds a PEM private key at that position/,
					JSON.stringify(cursor)
				);
			}
			const after = await readFileTool.handler({ root: 'logs', path: 'hdb.log', startLine: 44 }, small);
			assert.equal(after.content, 'after the key\n');
		});
	});
});
