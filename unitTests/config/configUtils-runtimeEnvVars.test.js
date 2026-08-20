'use strict';

const assert = require('node:assert');
const rewire = require('rewire');
const sinon = require('sinon');
const os = require('node:os');
const fs = require('fs-extra');
const YAML = require('yaml');
// configUtils now imports these as ES modules; stub them on the shared module
// objects (configUtils reads the same cached instances) instead of swapping the
// bindings via rewire, which the TS-compiled output no longer exposes by name.
const harperConfigEnvVars = require('#src/config/harperConfigEnvVars');
const loggerModule = require('#src/utility/logging/harper_logger');
const loggerObj = loggerModule.default || loggerModule;

const configUtils = rewire('#src/config/configUtils');
const applyRuntimeEnvVarConfig = configUtils.__get__('applyRuntimeEnvVarConfig');

describe('configUtils - applyRuntimeEnvVarConfig', function () {
	let mockConfigDoc;
	let prepareRuntimeEnvConfigStub;
	let saveEnvConfigStateStub;
	let hasPersistedEnvConfigStateStub;
	let fsWriteFileSyncStub;
	let fsRenameSyncStub;
	let loggerStub;
	let YAMLStub;

	before(function () {
		// Stub the dependencies on their shared module objects. configUtils calls
		// harperConfigEnvVars.prepareRuntimeEnvConfig / .hasPersistedEnvConfigState,
		// fs.writeFileSync / .renameSync, the logger methods, and YAML.parse/stringify
		// via these same cached modules, so stubbing here intercepts those calls.
		prepareRuntimeEnvConfigStub = sinon.stub(harperConfigEnvVars, 'prepareRuntimeEnvConfig');
		hasPersistedEnvConfigStateStub = sinon.stub(harperConfigEnvVars, 'hasPersistedEnvConfigState');
		fsWriteFileSyncStub = sinon.stub(fs, 'writeFileSync');
		fsRenameSyncStub = sinon.stub(fs, 'renameSync');
		loggerStub = {
			debug: sinon.stub(loggerObj, 'debug'),
			warn: sinon.stub(loggerObj, 'warn'),
			error: sinon.stub(loggerObj, 'error'),
		};

		// Create default YAML stub
		YAMLStub = {
			parseDocument: sinon.stub(YAML, 'parseDocument').returns({ errors: [] }),
			stringify: sinon.stub(YAML, 'stringify').returns('yaml: content'),
		};
	});

	beforeEach(function () {
		// Reset stubs
		prepareRuntimeEnvConfigStub.reset();
		saveEnvConfigStateStub = sinon.stub();
		prepareRuntimeEnvConfigStub.returns({ config: { http: { port: 9925 } }, saveState: saveEnvConfigStateStub });
		hasPersistedEnvConfigStateStub.reset();
		hasPersistedEnvConfigStateStub.returns(false); // default: no prior state
		fsWriteFileSyncStub.reset();
		fsRenameSyncStub.reset();
		loggerStub.debug.reset();
		loggerStub.warn.reset();
		loggerStub.error.reset();

		// Reset YAML stub to default (no errors)
		YAMLStub.parseDocument.reset();
		YAMLStub.parseDocument.returns({ errors: [] });
		YAMLStub.stringify.reset();
		YAMLStub.stringify.returns('yaml: content');

		// Create mock config doc
		mockConfigDoc = {
			getIn: sinon.stub(),
			toJSON: sinon.stub(),
			errors: [],
		};

		// Default stub returns
		mockConfigDoc.getIn.withArgs(['rootPath']).returns('/test/root');
		mockConfigDoc.toJSON.returns({ http: { port: 9925 } });
	});

	after(function () {
		sinon.restore();
	});

	it('should skip when no env vars set and no prior state', function () {
		delete process.env.HARPER_DEFAULT_CONFIG;
		delete process.env.HARPER_CONFIG;
		delete process.env.HARPER_SET_CONFIG;
		hasPersistedEnvConfigStateStub.returns(false);

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(prepareRuntimeEnvConfigStub.called, false);
		assert.strictEqual(fsWriteFileSyncStub.called, false);
	});

	it('should run cleanup when no env vars set but prior state exists (var removed)', function () {
		// All three vars were applied on a prior boot and then removed: the wrapper must NOT
		// short-circuit — prepareRuntimeEnvConfig has to restore originals and clear the snapshot.
		delete process.env.HARPER_DEFAULT_CONFIG;
		delete process.env.HARPER_CONFIG;
		delete process.env.HARPER_SET_CONFIG;
		hasPersistedEnvConfigStateStub.returns(true);

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(prepareRuntimeEnvConfigStub.called, true, 'cleanup must run when state exists');
		assert.strictEqual(prepareRuntimeEnvConfigStub.firstCall.args[1], '/test/root');
		assert.strictEqual(fsWriteFileSyncStub.called, true);
	});

	it('should apply HARPER_DEFAULT_CONFIG when set', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		delete process.env.HARPER_SET_CONFIG;

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(prepareRuntimeEnvConfigStub.called, true);
		assert.strictEqual(prepareRuntimeEnvConfigStub.firstCall.args[1], '/test/root');
		assert.strictEqual(fsWriteFileSyncStub.called, true);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should apply HARPER_SET_CONFIG when set', function () {
		delete process.env.HARPER_DEFAULT_CONFIG;
		process.env.HARPER_SET_CONFIG = '{"http":{"port":8888}}';

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(prepareRuntimeEnvConfigStub.called, true);
		assert.strictEqual(fsWriteFileSyncStub.called, true);

		delete process.env.HARPER_SET_CONFIG;
	});

	it('should apply both env vars when both set', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		process.env.HARPER_SET_CONFIG = '{"logging":{"level":"debug"}}';

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(prepareRuntimeEnvConfigStub.called, true);
		assert.strictEqual(fsWriteFileSyncStub.called, true);

		delete process.env.HARPER_DEFAULT_CONFIG;
		delete process.env.HARPER_SET_CONFIG;
	});

	it('should warn and skip when rootPath not found', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		mockConfigDoc.getIn.withArgs(['rootPath']).returns(undefined);

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(loggerStub.warn.called, true);
		assert.match(loggerStub.warn.firstCall.args[0], /rootPath not found/);
		assert.strictEqual(prepareRuntimeEnvConfigStub.called, false);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should write config file after applying env vars', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		// Atomic write: writeFileSync writes to a temp path, then renameSync moves it over the target
		assert.strictEqual(fsWriteFileSyncStub.called, true);
		const writeTarget = fsWriteFileSyncStub.firstCall.args[0];
		assert.ok(writeTarget.startsWith('/test/config.yaml.'), `expected temp path, got ${writeTarget}`);
		assert.ok(writeTarget.endsWith('.tmp'), `expected .tmp suffix, got ${writeTarget}`);
		assert.strictEqual(fsRenameSyncStub.calledOnce, true);
		assert.deepStrictEqual(fsRenameSyncStub.firstCall.args, [writeTarget, '/test/config.yaml']);
		assert.strictEqual(loggerStub.debug.called, true);
		assert.match(loggerStub.debug.firstCall.args[0], /Config file updated/);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should throw error if config doc has errors', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';

		// Override YAML stub to return a doc with errors for this test
		YAMLStub.parseDocument.returns({ errors: ['Parse error'] });

		assert.throws(
			() => applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml'),
			/Error parsing harperdb-config.yaml/
		);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should log error and rethrow on file write failure', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		fsWriteFileSyncStub.throws(new Error('Permission denied'));

		assert.throws(() => applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml'), /Permission denied/);

		assert.strictEqual(loggerStub.error.called, true);
		assert.match(loggerStub.error.firstCall.args[0], /Failed to write config file/);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should skip file write when configFilePath is not provided', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';

		// Call without configFilePath
		applyRuntimeEnvVarConfig(mockConfigDoc, null);

		// Should apply env vars
		assert.strictEqual(prepareRuntimeEnvConfigStub.called, true);
		// But should NOT write to file
		assert.strictEqual(fsWriteFileSyncStub.called, false);
		// And should NOT log the "Config file updated" message
		assert.strictEqual(loggerStub.debug.called, false);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should pass options parameter to prepareRuntimeEnvConfig', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		const options = { isInstall: true };

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml', options);

		assert.strictEqual(prepareRuntimeEnvConfigStub.called, true);
		assert.deepStrictEqual(prepareRuntimeEnvConfigStub.firstCall.args[2], options);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	describe('error handling in YAML processing', function () {
		it('should log error and rethrow when prepareRuntimeEnvConfig throws (most likely scenario)', function () {
			// This is the most realistic failure case - invalid env var values, state file issues, etc.
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":"invalid"}}';
			prepareRuntimeEnvConfigStub.throws(new Error('Invalid port value'));

			assert.throws(() => applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml'), /Invalid port value/);

			assert.strictEqual(loggerStub.error.called, true);
			assert.match(loggerStub.error.firstCall.args[0], /Failed to apply runtime env config/);

			delete process.env.HARPER_DEFAULT_CONFIG;
		});

		it('should log error and rethrow when YAML.stringify() fails', function () {
			// Could happen with circular references or objects that don't serialize well
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			YAMLStub.stringify.throws(new Error('Cannot stringify circular reference'));

			assert.throws(
				() => applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml'),
				/Cannot stringify circular reference/
			);

			assert.strictEqual(loggerStub.error.called, true);
			assert.match(loggerStub.error.firstCall.args[0], /Failed to apply runtime env config/);

			delete process.env.HARPER_DEFAULT_CONFIG;
		});

		it('should log error and rethrow when YAML.parseDocument() fails', function () {
			// Could happen if stringify produces invalid YAML (unlikely but possible)
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			YAMLStub.parseDocument.throws(new Error('Invalid YAML structure'));

			assert.throws(() => applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml'), /Invalid YAML structure/);

			assert.strictEqual(loggerStub.error.called, true);
			assert.match(loggerStub.error.firstCall.args[0], /Failed to apply runtime env config/);

			delete process.env.HARPER_DEFAULT_CONFIG;
		});
	});
	// Storage exhaustion at boot (#847): persisting the merged config is a derived artifact, so a
	// full or quota-exhausted volume must leave the process running on the in-memory config rather
	// than aborting startup into a restart loop nothing inside the container can break.
	describe('storage exhaustion', function () {
		// Linux reports EDQUOT with no code mapping - `Unknown system error -122` - so the errno is
		// the only signal the classifier can use (122 on Linux, 69 on macOS).
		const quotaErrno = os.constants.errno.EDQUOT;
		const edquotError = Object.assign(new Error(`Unknown system error -${quotaErrno}`), {
			errno: -quotaErrno,
			code: `Unknown system error -${quotaErrno}`,
			syscall: 'open',
		});
		const enospcError = Object.assign(new Error('ENOSPC: no space left on device, open'), {
			errno: -os.constants.errno.ENOSPC,
			code: 'ENOSPC',
			syscall: 'open',
		});

		afterEach(function () {
			delete process.env.HARPER_DEFAULT_CONFIG;
		});

		it('continues boot when the config write fails with EDQUOT', function () {
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			YAMLStub.parseDocument.returns({ errors: [], contents: 'merged contents' });
			fsWriteFileSyncStub.throws(edquotError);

			applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

			assert.strictEqual(mockConfigDoc.contents, 'merged contents', 'merged config still applied in memory');
			assert.strictEqual(loggerStub.error.called, true);
			assert.match(loggerStub.error.firstCall.args[0], /Storage exhausted/);
		});

		it('continues boot when the config write fails with ENOSPC', function () {
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			fsWriteFileSyncStub.throws(enospcError);

			applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

			assert.strictEqual(loggerStub.error.called, true);
			assert.match(loggerStub.error.firstCall.args[0], /Storage exhausted/);
		});

		it('does not save the env state snapshot when the config write failed', function () {
			// The snapshot describes what the config file holds. Writing it against a file that was
			// never updated makes the next boot read the older file value as a manual user edit and
			// stop applying the env layer entirely.
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			fsWriteFileSyncStub.throws(edquotError);

			applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

			assert.strictEqual(saveEnvConfigStateStub.called, false);
		});

		it('saves the env state snapshot after a successful config write', function () {
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';

			applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

			assert.strictEqual(saveEnvConfigStateStub.calledOnce, true);
			assert.strictEqual(fsRenameSyncStub.calledBefore(saveEnvConfigStateStub), true);
		});

		it('continues boot when only the env state save is exhausted', function () {
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			saveEnvConfigStateStub.throws(edquotError);

			applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

			assert.strictEqual(loggerStub.error.called, true);
			assert.match(loggerStub.error.firstCall.args[0], /Storage exhausted/);
		});

		it('still fails the install path, which has no started process to keep alive', function () {
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			saveEnvConfigStateStub.throws(edquotError);

			assert.throws(() => applyRuntimeEnvVarConfig(mockConfigDoc, null, { isInstall: true }), /Unknown system error/);
		});

		it('still throws on a write error that is not storage exhaustion', function () {
			process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
			fsWriteFileSyncStub.throws(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

			assert.throws(() => applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml'), /permission denied/);
		});
	});
});
