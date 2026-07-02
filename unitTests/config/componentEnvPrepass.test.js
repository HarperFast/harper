'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyComponentEnvConfigVars, resolveConfiguredPath } = require('#src/config/componentEnvPrepass');

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

	it('applies config-shaping vars from a component .env under componentsRoot', () => {
		writeComponent('app', 'loadEnv:\n  files: .env\n', {
			'.env': 'HARPER_CONFIG={"mcp":{"application":{"mountPath":"/mcp"}}}\n__PREPASS_OTHER=ignored\n',
		});
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, true);
		assert.equal(process.env.HARPER_CONFIG, '{"mcp":{"application":{"mountPath":"/mcp"}}}');
		// only the config-shaping vars are applied early; other keys wait for loadEnv at component load
		assert.equal(process.env.__PREPASS_OTHER, undefined);
	});

	it('applies from a directly-run app folder (harper run <dir>)', () => {
		const appDir = writeComponent('run-app', 'loadEnv:\n  files: .env\n', {
			'.env': 'HARPER_SET_CONFIG=http.port=9999\n',
		});
		const applied = applyComponentEnvConfigVars(undefined, appDir);
		assert.equal(applied, true);
		assert.equal(process.env.HARPER_SET_CONFIG, 'http.port=9999');
	});

	it('a real process env var wins over the .env value', () => {
		process.env.HARPER_CONFIG = 'from-process';
		writeComponent('app', 'loadEnv:\n  files: .env\n', { '.env': 'HARPER_CONFIG=from-dotenv\n' });
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, false);
		assert.equal(process.env.HARPER_CONFIG, 'from-process');
	});

	it('honors loadEnv override: the .env value beats a process env var', () => {
		process.env.HARPER_CONFIG = 'from-process';
		writeComponent('app', 'loadEnv:\n  files: .env\n  override: true\n', { '.env': 'HARPER_CONFIG=from-dotenv\n' });
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, true);
		assert.equal(process.env.HARPER_CONFIG, 'from-dotenv');
	});

	it('skips encrypted values', () => {
		writeComponent('app', 'loadEnv:\n  files: .env\n', { '.env': 'HARPER_CONFIG=enc:v1:CIPHERTEXT\n' });
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, false);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('resolves glob file patterns like the loadEnv plugin', () => {
		writeComponent('app', 'loadEnv:\n  files: "*.env"\n', { 'settings.env': 'HARPER_CONFIG=via-glob\n' });
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, true);
		assert.equal(process.env.HARPER_CONFIG, 'via-glob');
	});

	it('ignores components without loadEnv, without config.yaml, and hidden directories', () => {
		writeComponent('no-load-env', 'jsResource:\n  files: res/*.js\n', { '.env': 'HARPER_CONFIG=nope\n' });
		writeComponent('no-config', null, { '.env': 'HARPER_CONFIG=nope\n' });
		writeComponent('.hidden', 'loadEnv:\n  files: .env\n', { '.env': 'HARPER_CONFIG=nope\n' });
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, false);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('honors the loader config-file precedence (harper-config.yaml over config.yaml)', () => {
		const dir = writeComponent('multi-config', 'loadEnv:\n  files: nope.env\n', {
			'.env': 'HARPER_CONFIG=from-harper-config\n',
		});
		fs.writeFileSync(path.join(dir, 'harper-config.yaml'), 'loadEnv:\n  files: .env\n');
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, true);
		assert.equal(process.env.HARPER_CONFIG, 'from-harper-config');
	});

	it('skips patterns that escape the component directory or are absolute', () => {
		const outside = writeComponent('outside', null, { 'outside.env': 'HARPER_CONFIG=escaped\n' });
		writeComponent('escaper', `loadEnv:\n  files:\n    - "../outside/*.env"\n    - "${outside}/outside.env"\n`);
		const applied = applyComponentEnvConfigVars(tempRoot, undefined);
		assert.equal(applied, false);
		assert.equal(process.env.HARPER_CONFIG, undefined);
	});

	it('tolerates a missing components root and missing declared env files', () => {
		writeComponent('missing-env', 'loadEnv:\n  files: .env\n'); // declares .env but none exists
		assert.equal(applyComponentEnvConfigVars(path.join(tempRoot, 'does-not-exist'), undefined), false);
		assert.equal(applyComponentEnvConfigVars(tempRoot, undefined), false);
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
