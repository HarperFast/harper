const assert = require('node:assert');
const { resolve, join } = require('node:path');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { waitFor } = require('./waitFor.js');
const { partitionSuites } = require('./typeStripSuites.mts');
const { loadOptions } = require('mocha/lib/cli/options.cjs');
const collectFiles = require('mocha/lib/cli/collect-files.cjs');
const root = resolve(__dirname, '..');
const fixtures = join(__dirname, 'fixtures/unitRuntimes');

function run(names, args = [], env = {}) {
	return spawnSync(
		process.execPath,
		[
			'unitTests/runTypeStripTests.mts',
			...names.map((name) => join(fixtures, name + '.js')),
			'--no-config',
			'--require',
			join(__dirname, 'mocha.init.js'),
			...args,
		],
		{
			cwd: root,
			encoding: 'utf8',
			timeout: 20000,
			env: { ...process.env, ...env },
		}
	);
}

function succeeds(result) {
	assert.strictEqual(result.status, 0, result.stdout + result.stderr);
}

describe('unit runtime selection', function () {
	this.timeout(30000);
	it('partitions Mocha collection exactly with source-compatible helpers and cache-mutating legacy suites', () => {
		const options = loadOptions([
			join(root, 'unitTests/**/*test.*js'),
			'--exclude',
			join(root, 'unitTests/resources/**'),
		]);
		options.ignore = options.ignore?.map((pattern) => resolve(root, pattern));
		const { files } = collectFiles({ ...options, spec: options._, file: options.file || [] });
		const lanes = partitionSuites(files);
		assert.deepStrictEqual([...lanes.source, ...lanes.compiled].sort(), [...new Set(files)].sort());
		assert.strictEqual(lanes.source.filter((file) => lanes.compiled.includes(file)).length, 0);
		assert(lanes.compiled.includes(require.resolve('./config/configUtils.test.js')));
		assert(lanes.compiled.includes(require.resolve('./components/gitSSHMaterialization.test.js')));
		assert(lanes.compiled.includes(require.resolve('./server/threads/threadServerStartupLiveness.test.js')));
		assert(lanes.compiled.includes(require.resolve('./server/threads/terminalShutdown.test.js')));
		assert(lanes.compiled.includes(require.resolve('./utility/logging/logFileIdentity.test.js')));
		assert(lanes.compiled.includes(require.resolve('./utility/interactivePrompts.test.js')));
		assert(partitionSuites([require.resolve('./resources/debugLongTransactionsReads.test.js')]).compiled.length);
		assert(lanes.source.includes(require.resolve('./components/deploymentRecorder.test.js')));
		assert(lanes.source.includes(require.resolve('./perFileDatabaseTeardown.test.js')));
	});
	it('executes both lanes, observes their files and propagates native resolution across processes', () => {
		const result = run(['source', 'compiled']);
		succeeds(result);
		assert.match(result.stdout, /Unit runtime: source, 1 files/);
		assert.match(result.stdout, /Unit runtime: compiled, 1 files/);
		assert.strictEqual((result.stdout.match(/1 passing/g) || []).length, 2);
	});
	it('honors an explicit source-only selection', () => {
		const result = run(['source', 'compiled'], ['--source-only']);
		succeeds(result);
		assert(!result.stdout.includes('Unit runtime: compiled'));
	});
	it('preserves compiled global setup as one lane, and refuses to omit it from source-only runs', () => {
		const args = ['--file', join(fixtures, 'compiled.js')];
		const result = run(['noDatabases'], args);
		succeeds(result);
		assert.match(result.stdout, /Unit runtime: compiled, 2 files/);
		assert(!result.stdout.includes('Unit runtime: source'));
		const sourceOnly = run(['noDatabases'], [...args, '--source-only']);
		assert.notStrictEqual(sourceOnly.status, 0);
		assert.match(sourceOnly.stderr, /Compiled --file setup cannot run/);
	});
	it('records an ESM setup file that registers hooks without defining a suite', () => {
		succeeds(run(['noDatabases'], ['--file', join(fixtures, 'setup.mjs')]));
		succeeds(run(['noDatabases', 'compiled'], ['--file', join(fixtures, 'setup.mjs')]));
	});
	it('requires completion hooks before running a custom configuration', () => {
		const result = spawnSync(
			process.execPath,
			['unitTests/runTypeStripTests.mts', '--no-config', join(fixtures, 'noDatabases.js')],
			{
				cwd: root,
				encoding: 'utf8',
				timeout: 20000,
			}
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /Require unitTests\/mocha.init.js/);
		assert(!result.stdout.includes('Unit runtime:'));
	});
	it('prints help and version without starting tests, and rejects parallel mode', () => {
		for (const flag of ['--help', '--version']) {
			const result = run([], [flag]);
			succeeds(result);
			assert(!result.stdout.includes('Unit runtime:'));
		}
		const result = run(['source'], ['--parallel']);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /ordinary mocha for parallel/);
	});
	it('honors a grep matching no tests, and applies fail-zero to the combined total', () => {
		succeeds(run(['source', 'compiled'], ['--grep', 'DOES_NOT_MATCH']));
		assert.notStrictEqual(run(['source', 'compiled'], ['--grep', 'DOES_NOT_MATCH', '--fail-zero']).status, 0);
		succeeds(run(['source', 'compiled'], ['--grep', 'native lane', '--fail-zero']));
	});
	it('rejects an ambient native condition before a compiled selection runs', () => {
		const result = run(['source', 'compiled'], [], { NODE_OPTIONS: '--conditions=typestrip' });
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /Unset the ambient typestrip/);
		assert(!result.stdout.includes('Unit runtime:'));
	});
	for (const name of ['fails', 'earlyExit', 'signal']) {
		it(`fails the invocation on ${name}`, () => {
			const result = run([name]);
			assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
		});
	}
	it('rejects unfinished later teardown and reporter completion', () => {
		for (const args of [
			['--require', join(fixtures, 'laterTeardown.cjs')],
			['--reporter', join(fixtures, 'unfinishedReporter.cjs')],
		]) {
			const result = run(['noDatabases'], args);
			assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stderr, /without finishing|did not complete/);
		}
	});
	it('supports a single-lane file reporter and prevents two lanes overwriting it', () => {
		const directory = mkdtempSync(join(root, 'unitTests/envDir/reporter-'));
		try {
			const output = join(directory, 'results.xml');
			succeeds(run(['source'], ['--reporter', 'xunit', '--reporter-option', `output=${output}`]));
			assert.match(readFileSync(output, 'utf8'), /<testsuite/);
			const result = run(['source', 'compiled'], ['--reporter', 'xunit', '--reporter-option', `output=${output}`]);
			assert.notStrictEqual(result.status, 0);
			assert.match(result.stderr, /Run lanes separately/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it('keeps utility-only native tests from loading the database registry', () => succeeds(run(['noDatabases'])));
	it('recognizes a compiled dependency through a local helper', () => {
		const directory = mkdtempSync(join(root, 'unitTests/envDir/dependency-'));
		try {
			writeFileSync(join(directory, 'helper.js'), "module.exports = require('#js/utility/hdbTerms');");
			writeFileSync(join(directory, 'test.js'), "require('./helper');");
			assert.strictEqual(partitionSuites([join(directory, 'test.js')]).compiled.length, 1);
			writeFileSync(join(directory, 'test.mjs'), "import './helper.js';");
			assert.strictEqual(partitionSuites([join(directory, 'test.mjs')]).compiled.length, 1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it('distinguishes cache reads, cache mutation, compiled artifacts and bare addon wrappers', () => {
		const directory = mkdtempSync(join(root, 'unitTests/envDir/classification-'));
		try {
			const file = join(directory, 'test.js');
			for (const [code, compiled] of [
				["require.cache[require.resolve('#src/utility/hdbTerms')];", false],
				["delete require.cache[require.resolve('#src/utility/hdbTerms')];", true],
				["require.cache[require.resolve('#src/utility/hdbTerms')] = {};", true],
				[
					`require('node:path').resolve(__dirname, ${JSON.stringify(require('node:path').relative(directory, join(root, 'dist/utility/hdbTerms.js')))});`,
					true,
				],
				["require('@harperfast/rocksdb-js');", true],
			]) {
				writeFileSync(file, code);
				assert.strictEqual(partitionSuites([file]).compiled.length, Number(compiled), code);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	for (const grep of [undefined, 'DOES_NOT_MATCH'])
		it(`finishes ordinary parallel workers with grep ${grep}`, () => {
			const result = spawnSync(
				process.execPath,
				[
					require.resolve('mocha/bin/mocha.js'),
					join(fixtures, 'noDatabases.js'),
					'--no-config',
					'--require',
					join(__dirname, 'mocha.init.js'),
					'--parallel',
					'--jobs',
					'1',
					'--exit',
					...(grep ? ['--grep', grep] : []),
				],
				{ cwd: root, encoding: 'utf8', timeout: 20000 }
			);
			succeeds(result);
			assert.match(result.stdout, grep ? /0 passing/ : /1 passing/);
			assert(!result.stderr.includes('without finishing'));
		});
	it('stops the real Mocha process on POSIX when interrupted through the node-option wrapper', async function () {
		if (process.platform === 'win32') return this.skip();
		const directory = mkdtempSync(join(root, 'unitTests/envDir/interrupt-'));
		const pidFile = join(directory, 'pid');
		const child = spawn(
			process.execPath,
			[
				'unitTests/runTypeStripTests.mts',
				join(fixtures, 'waitForInterrupt.js'),
				'--no-config',
				'--require',
				join(__dirname, 'mocha.init.js'),
				'--node-option',
				'expose-internals',
			],
			{ cwd: root, env: { ...process.env, HARPER_TEST_PROCESS_PID: pidFile }, stdio: 'ignore' }
		);
		let testPid;
		const closed = once(child, 'close', { signal: AbortSignal.timeout(20000) });
		closed.catch(() => {});
		function stopped() {
			try {
				process.kill(testPid, 0);
				return false;
			} catch (error) {
				if (error.code === 'ESRCH') return true;
				throw error;
			}
		}
		try {
			await waitFor(() => existsSync(pidFile), 10000);
			testPid = Number(readFileSync(pidFile, 'utf8'));
			assert(Number.isInteger(testPid) && testPid > 0);
			child.kill('SIGTERM');
			const [code] = await closed;
			assert.strictEqual(code, 143);
			await waitFor(stopped, 5000);
		} finally {
			child.kill('SIGINT');
			if (testPid && !stopped()) process.kill(testPid, 'SIGKILL');
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
