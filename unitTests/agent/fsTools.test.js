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

describe('agent/fsTools key material and the single-file config scope (harper#3041)', () => {
	const PEM = '-----BEGIN PRIVATE KEY-----\nMIIfakekeybody\n-----END PRIVATE KEY-----\n';
	let root;

	// The default-install layout: the config file sits in rootPath beside keys/, ssh/ and database/.
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-root-')));
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
	});
});
