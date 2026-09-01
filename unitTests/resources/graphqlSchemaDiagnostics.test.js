const assert = require('node:assert');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const logger = require('#src/utility/logging/harper_logger');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { loadGQLSchema, handleApplication } = require('#src/resources/graphql');
const { Scope } = require('#src/components/Scope');
const { ApplicationScope } = require('#src/components/ApplicationScope');
const { Resources } = require('#src/resources/Resources');
const { restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');

describe('graphqlSchema load diagnostics (#1917)', () => {
	let warnings;
	let errors;
	let originalWarn;
	let originalError;

	before(() => {
		setupTestDBPath();
	});

	beforeEach(() => {
		warnings = [];
		errors = [];
		originalWarn = logger.warn;
		originalError = logger.error;
		logger.warn = (...args) => warnings.push(args.join(' '));
		logger.error = (...args) => errors.push(args.join(' '));
	});

	afterEach(() => {
		logger.warn = originalWarn;
		logger.error = originalError;
	});

	describe('parse failures', () => {
		it('logs the GraphQL source excerpt, line/column and caret', async () => {
			await assert.rejects(loadGQLSchema('type Broken {\n\tid: ID!\n'));

			const logged = errors.find((line) => line.includes('Syntax Error'));
			assert.ok(logged, `expected a logged syntax error, got: ${JSON.stringify(errors)}`);
			assert.match(logged, /<inline-schema>:\d+:\d+/, 'the log must carry the file, line and column');
			assert.match(logged, /\^/, 'the log must carry the caret pointing at the offending token');
		});

		it('keeps the schema source out of the error the loader hands to clients', async () => {
			// A failed component load is stored as an ErrorResource whose message REST copies verbatim
			// into the problem-response title, so the excerpt and the absolute path must not be in it.
			await assert.rejects(loadGQLSchema('type Broken {\n\tid: ID!\n'), (error) => {
				assert.match(error.message, /^Invalid GraphQL schema/);
				assert.doesNotMatch(error.message, /\^/, 'the excerpt must not reach the thrown message');
				assert.doesNotMatch(error.message, /Syntax Error/, 'the parser detail must not reach the thrown message');
				assert.ok(!error.message.includes('<inline-schema>'), 'the file path must not reach the thrown message');
				return true;
			});
		});
	});

	describe('unknown field directives', () => {
		it('warns for a directive nothing recognizes', async () => {
			await loadGQLSchema('type Unknowable {\n\tid: ID @bogus\n}');

			const warned = warnings.find((line) => line.includes('@bogus'));
			assert.ok(warned, `expected an unknown-directive warning, got: ${JSON.stringify(warnings)}`);
			assert.match(warned, /is an unknown field directive/);
			assert.match(warned, /line \d+, column \d+/, 'the warning must locate the directive');
		});

		it('does not warn for a Harper-registered directive', async () => {
			await loadGQLSchema('type HarperDirective {\n\tid: ID @indexed\n}');
			assert.deepStrictEqual(
				warnings.filter((line) => line.includes('unknown field directive')),
				[]
			);
		});

		it('does not warn for a directive the GraphQL spec defines', async () => {
			await loadGQLSchema('type SpecDirective {\n\tid: ID @deprecated(reason: "moved")\n}');
			assert.deepStrictEqual(
				warnings.filter((line) => line.includes('unknown field directive')),
				[]
			);
		});

		it('does not warn for a directive the schema declares itself', async () => {
			await loadGQLSchema('directive @audit on FIELD_DEFINITION\ntype SelfDeclared {\n\tid: ID @audit\n}');
			assert.deepStrictEqual(
				warnings.filter((line) => line.includes('unknown field directive')),
				[]
			);
		});
	});

	it('routes the duplicate @primaryKey warning through the logger', async () => {
		await loadGQLSchema('type TwoKeys {\n\tfirst: ID @primaryKey\n\tsecond: ID @primaryKey\n}');

		const warned = warnings.find((line) => line.includes('two attributes as a primary key'));
		assert.ok(warned, `expected a duplicate primary key warning, got: ${JSON.stringify(warnings)}`);
		assert.match(warned, /line \d+, column \d+/, 'the warning must locate the second directive');
	});

	describe('a schema corrected after a failed load', () => {
		let directory;
		let openScope;

		// Closed here rather than at the end of the test so a failed assertion cannot leave a chokidar
		// watcher running over the directory this hook is about to delete.
		afterEach(async () => {
			try {
				await openScope?.close();
			} finally {
				openScope = undefined;
				resetRestartNeeded();
				if (directory) rmSync(directory, { recursive: true, force: true });
				directory = undefined;
			}
		});

		it('settles the plugin on the failure and then requests a restart', async () => {
			directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.graphql-'));
			const schemaPath = join(directory, 'schema.graphql');
			writeFileSync(schemaPath, 'type Recovered @table {\n\tid: ID @primaryKey\n');
			const configFilePath = join(directory, 'config.yaml');
			writeFileSync(configFilePath, stringify({ graphqlSchema: { files: 'schema.graphql' } }));
			resetRestartNeeded();

			const scope = new Scope(
				basename(directory),
				'graphqlSchema',
				directory,
				configFilePath,
				new ApplicationScope('test', new Resources(), {})
			);
			openScope = scope;
			await scope.ready;

			// Raced, not awaited: mocha runs with no test timeout, so a promise that never settles — which
			// is exactly the bug — would hang the suite instead of failing it.
			let watchdog;
			const outcome = await Promise.race([
				handleApplication(scope).then(
					() => 'resolved',
					() => 'rejected'
				),
				new Promise((resolve) => {
					watchdog = setTimeout(() => resolve('pending'), 5_000);
				}),
			]);
			clearTimeout(watchdog);
			assert.strictEqual(
				outcome,
				'rejected',
				'the plugin must settle on the schema failure, not wait out the watchdog'
			);
			assert.strictEqual(restartNeeded(), false, 'the failing load itself must not request a restart');

			// The component is already published as failed, so reprocessing the corrected schema in place
			// would leave that state behind.
			writeFileSync(schemaPath, 'type Recovered @table {\n\tid: ID @primaryKey\n}\n');
			await waitFor(() => restartNeeded(), {
				timeout: 5_000,
				message: 'correcting the schema after a failed load must request a restart',
			});
		});
	});

	it('routes the unknown-type report through the logger', async () => {
		// The report is emitted only by worker 0; outside a worker thread getWorkerIndex() is undefined.
		setMainIsWorker(true);
		try {
			await loadGQLSchema('type ReferencesUnknown {\n\tother: Bar\n}');
		} finally {
			setMainIsWorker(false);
		}

		const reported = errors.find((line) => line.includes('The type Bar is unknown'));
		assert.ok(reported, `expected an unknown-type report, got: ${JSON.stringify(errors)}`);
		assert.match(reported, /line \d+, column \d+/);
	});
});
