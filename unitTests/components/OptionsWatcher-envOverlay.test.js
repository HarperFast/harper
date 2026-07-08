/**
 * OptionsWatcher runtime-env-config overlay (#1618).
 *
 * The on-disk root config (`harper-config.yaml`) is not guaranteed to contain
 * runtime env config (HARPER_SET_CONFIG et al.) when component scopes boot —
 * the file flush races component loading. These tests pin the fix: every
 * root-config read composes the env layers over the file content, so
 * `scope.options` always matches the resolved config the componentLoader used.
 * Application config files (`config.yaml`) are never overlaid.
 */
const { OptionsWatcher } = require('#src/components/OptionsWatcher');
const assert = require('node:assert');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');

const NAME = 'modelsGateway';
const ENV_KEYS = ['HARPER_SET_CONFIG', 'HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG'];

describe('OptionsWatcher env-config overlay (#1618)', () => {
	let dir;
	let savedEnv;
	let watcher;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'options-watcher-env-'));
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(async () => {
		await watcher?.close();
		watcher = undefined;
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it('delivers env config for a key missing from the root config file', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ http: { port: 9926 } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		const [config] = await watcher.ready;
		assert.deepStrictEqual(config, { enabled: true });
		assert.strictEqual(watcher.get(['enabled']), true);
	});

	it('env config overrides the file value on a root config read', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['enabled']), true);
	});

	it('does NOT overlay env config onto an application config file', async () => {
		const filePath = join(dir, 'config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['enabled']), false);
	});

	it('delivers env config when the root config file does not exist yet (install window)', async () => {
		const filePath = join(dir, 'harper-config.yaml'); // never written
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		const [config] = await watcher.ready;
		assert.deepStrictEqual(config, { enabled: true });
	});

	it('reads the file verbatim when no config env vars are set', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false } }));

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['enabled']), false);
	});
});
