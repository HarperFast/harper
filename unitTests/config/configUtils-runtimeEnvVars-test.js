'use strict';

const assert = require('node:assert/strict');
const rewire = require('rewire');
const sinon = require('sinon');

const configUtils = rewire('../../config/configUtils.js');
const applyRuntimeEnvVarConfig = configUtils.__get__('applyRuntimeEnvVarConfig');

describe('configUtils - applyRuntimeEnvVarConfig', function () {
	let mockConfigDoc;
	let applyRuntimeEnvConfigStub;
	let fsWriteFileSyncStub;
	let loggerStub;
	let YAMLStub;

	before(function () {
		// Create stubs for dependencies
		applyRuntimeEnvConfigStub = sinon.stub();
		fsWriteFileSyncStub = sinon.stub();
		loggerStub = {
			debug: sinon.stub(),
			warn: sinon.stub(),
			error: sinon.stub(),
		};

		// Create default YAML stub
		YAMLStub = {
			parseDocument: sinon.stub().returns({ errors: [] }),
			stringify: sinon.stub().returns('yaml: content'),
		};

		// Inject stubs
		configUtils.__set__('logger', loggerStub);
		configUtils.__set__('fs', { writeFileSync: fsWriteFileSyncStub });
		configUtils.__set__('YAML', YAMLStub);

		// Mock harperConfigEnvVars module
		configUtils.__set__('require', function (modulePath) {
			if (modulePath === './harperConfigEnvVars.ts') {
				return { applyRuntimeEnvConfig: applyRuntimeEnvConfigStub };
			}
			return require(modulePath);
		});
	});

	beforeEach(function () {
		// Reset stubs
		applyRuntimeEnvConfigStub.reset();
		fsWriteFileSyncStub.reset();
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

	it('should skip when no env vars set', function () {
		delete process.env.HARPER_DEFAULT_CONFIG;
		delete process.env.HARPER_SET_CONFIG;

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(applyRuntimeEnvConfigStub.called, false);
		assert.strictEqual(fsWriteFileSyncStub.called, false);
	});

	it('should apply HARPER_DEFAULT_CONFIG when set', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		delete process.env.HARPER_SET_CONFIG;

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(applyRuntimeEnvConfigStub.called, true);
		assert.strictEqual(applyRuntimeEnvConfigStub.firstCall.args[1], '/test/root');
		assert.strictEqual(fsWriteFileSyncStub.called, true);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should apply HARPER_SET_CONFIG when set', function () {
		delete process.env.HARPER_DEFAULT_CONFIG;
		process.env.HARPER_SET_CONFIG = '{"http":{"port":8888}}';

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(applyRuntimeEnvConfigStub.called, true);
		assert.strictEqual(fsWriteFileSyncStub.called, true);

		delete process.env.HARPER_SET_CONFIG;
	});

	it('should apply both env vars when both set', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		process.env.HARPER_SET_CONFIG = '{"logging":{"level":"debug"}}';

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(applyRuntimeEnvConfigStub.called, true);
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
		assert.strictEqual(applyRuntimeEnvConfigStub.called, false);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should write config file after applying env vars', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml');

		assert.strictEqual(fsWriteFileSyncStub.called, true);
		assert.strictEqual(fsWriteFileSyncStub.firstCall.args[0], '/test/config.yaml');
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
		assert.strictEqual(applyRuntimeEnvConfigStub.called, true);
		// But should NOT write to file
		assert.strictEqual(fsWriteFileSyncStub.called, false);
		// And should NOT log the "Config file updated" message
		assert.strictEqual(loggerStub.debug.called, false);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});

	it('should pass options parameter to applyRuntimeEnvConfig', function () {
		process.env.HARPER_DEFAULT_CONFIG = '{"http":{"port":9999}}';
		const options = { isInstall: true };

		applyRuntimeEnvVarConfig(mockConfigDoc, '/test/config.yaml', options);

		assert.strictEqual(applyRuntimeEnvConfigStub.called, true);
		assert.deepStrictEqual(applyRuntimeEnvConfigStub.firstCall.args[2], options);

		delete process.env.HARPER_DEFAULT_CONFIG;
	});
});
