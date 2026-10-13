const assert = require('node:assert');
const { resolve, join } = require('node:path');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
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
	it('keeps ordinary parallel Mocha workers from reporting a false unfinished run', () => {
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
			],
			{ cwd: root, encoding: 'utf8', timeout: 20000 }
		);
		succeeds(result);
		assert.match(result.stdout, /1 passing/);
		assert(!result.stderr.includes('without finishing'));
	});
});
