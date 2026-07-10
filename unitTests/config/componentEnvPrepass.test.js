'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { warnComponentEnvConfigVars, resolveConfiguredPath } = require('#src/config/componentEnvPrepass');
const logger = require('#src/utility/logging/harper_logger');

describe('componentEnvPrepass (#1513)', () => {
	let tempRoot;
	const TOUCHED = ['HARPER_CONFIG', 'HARPER_SET_CONFIG', 'HARPER_DEFAULT_CONFIG', '__PREPASS_OTHER'];
	const saved = {};

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prepass-test-'));
		for (const key of TOUCHED) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
		for (const key of TOUCHED) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	function writeComponent(name, configYaml, envFiles = {}) {
		const dir = path.join(tempRoot, name);
		fs.mkdirSync(dir, { recursive: true });
		if (configYaml != null) fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml);
		for (const [fileName, contents] of Object.entries(envFiles)) {
			fs.writeFileSync(path.join(dir, fileName), contents);
		}
		return dir;
	}

	it('warns about config-shaping vars in a component .env and does NOT apply them', () => {
		writeComponent('app', 'loadEnv:\n  files: .env\n', {
			'.env': 'HARPER_CONFIG={"mcp":{"application":{"mountPath":"/mcp"}}}\n__PREPASS_OTHER=ignored\n',
		});
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (msg) => warnings.push(String(msg));
		try {
			const found = warnComponentEnvConfigVars(tempRoot, undefined);
			assert.equal(found, 1);
		} finally {
			logger.warn = originalWarn;
		}
		// nothing is applied — components must not shape instance config
		assert.equal(process.env.HARPER_CONFIG, undefined);
		assert.equal(process.env.__PREPASS_OTHER, undefined);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0].includes('HARPER_CONFIG'), 'warning names the variable');
		assert.ok(warnings[0].includes('.env'), 'warning names the file');
		assert.ok(warnings[0].includes('NOT applied'), 'warning states the value is not applied');
	});

	it('detects vars in a directly-run app folder (harper run <dir>)', () => {
		const appDir = writeComponent('run-app', 'loadEnv:\n  files: .env\n', {
			'.env': 'HARPER_SET_CONFIG=http.port=9999\n',
		});
		assert.equal(warnComponentEnvConfigVars(undefined, appDir), 1);
		assert.equal(process.env.HARPER_SET_CONFIG, undefined);
	});

	it('warns even when a real process env var is also set, and never overrides it', () => {
		process.env.HARPER_CONFIG = 'from-process';
		writeComponent('app', 'loadEnv:\n  files: .env\n  override: true\n', { '.env': 'HARPER_CONFIG=from-dotenv\n' });
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 1);
		assert.equal(process.env.HARPER_CONFIG, 'from-process', 'process env untouched regardless of loadEnv override');
	});

	it('detects encrypted values too (equally not applied)', () => {
		writeComponent('app', 'loadEnv:\n  files: .env\n', { '.env': 'HARPER_CONFIG=enc:v1:CIPHERTEXT\n' });
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 1);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('resolves glob file patterns like the loadEnv plugin', () => {
		writeComponent('app', 'loadEnv:\n  files: "*.env"\n', { 'settings.env': 'HARPER_CONFIG=via-glob\n' });
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 1);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('ignores components without loadEnv, without config.yaml, and hidden directories', () => {
		writeComponent('no-load-env', 'jsResource:\n  files: res/*.js\n', { '.env': 'HARPER_CONFIG=nope\n' });
		writeComponent('no-config', null, { '.env': 'HARPER_CONFIG=nope\n' });
		writeComponent('.hidden', 'loadEnv:\n  files: .env\n', { '.env': 'HARPER_CONFIG=nope\n' });
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 0);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('honors the loader config-file precedence (harper-config.yaml over config.yaml)', () => {
		const dir = writeComponent('multi-config', 'loadEnv:\n  files: nope.env\n', {
			'.env': 'HARPER_CONFIG=from-harper-config\n',
		});
		fs.writeFileSync(path.join(dir, 'harper-config.yaml'), 'loadEnv:\n  files: .env\n');
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 1, 'harper-config.yaml declaration is honored');
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('skips patterns that escape the component directory or are absolute', () => {
		const outside = writeComponent('outside', null, { 'outside.env': 'HARPER_CONFIG=escaped\n' });
		writeComponent('escaper', `loadEnv:\n  files:\n    - "../outside/*.env"\n    - "${outside}/outside.env"\n`);
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 0);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('tolerates a missing components root and missing declared env files', () => {
		writeComponent('missing-env', 'loadEnv:\n  files: .env\n'); // declares .env but none exists
		assert.equal(warnComponentEnvConfigVars(path.join(tempRoot, 'does-not-exist'), undefined), 0);
		assert.equal(warnComponentEnvConfigVars(tempRoot, undefined), 0);
	});

	describe('resolveConfiguredPath', () => {
		it('resolves tilde, absolute, relative, and undefined values', () => {
			assert.equal(resolveConfiguredPath('~/hdb', undefined), path.join(os.homedir(), 'hdb'));
			assert.equal(resolveConfiguredPath('/abs/path', '/root'), '/abs/path');
			assert.equal(resolveConfiguredPath('components', '/root'), path.resolve('/root', 'components'));
			assert.equal(resolveConfiguredPath(undefined, '/root'), undefined);
		});
	});
});
