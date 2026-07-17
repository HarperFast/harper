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

	it('still emits ready when the file is absent and env config lacks this scope (no remove/hang)', async () => {
		const filePath = join(dir, 'harper-config.yaml'); // never written
		process.env.HARPER_SET_CONFIG = JSON.stringify({ http: { port: 12345 } }); // some OTHER scope

		watcher = new OptionsWatcher(NAME, filePath);
		const [config] = await watcher.ready; // regression guard: must resolve, not hang on 'remove'
		assert.strictEqual(config, undefined);
	});

	it('overlays env config onto the legacy root config filename (harperdb-config.yaml)', async () => {
		const filePath = join(dir, 'harperdb-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['enabled']), true);
	});
});

describe('OptionsWatcher env-config resilience (#1726 review)', () => {
	const NAME = 'modelsGateway';
	const ENV_KEYS = ['HARPER_SET_CONFIG', 'HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG'];
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

	it('a bare `componentName: {}` scope in the root config file survives when env vars are set', async function () {
		// Regression guard: the base file used to be routed through the env-layer flatten,
		// which drops empty objects — the scope vanished from the composed root config and
		// boot hung waiting for `ready` (or an already-ready watcher got `remove`).
		this.timeout(4000);
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: {} }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ http: { port: 12345 } }); // some OTHER scope

		watcher = new OptionsWatcher(NAME, filePath);
		const [config] = await watcher.ready;
		assert.deepStrictEqual(config, {}, 'the empty scope is user content and must reach ready');
	});

	it('deleting the root config file keeps an env-defined scope alive (merge, not remove)', async function () {
		// #handleUnlink used to reset to DEFAULT_CONFIG unconditionally, discarding
		// HARPER_SET_CONFIG-defined scopes — the same env-independence the ENOENT read
		// path preserves. The unlink now applies the same env-only overlay; this also
		// exercises the shared merge branch (config already set → merge, never reset).
		this.timeout(4000);
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false, fileOnly: 1 } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['enabled']), true);
		assert.strictEqual(watcher.get(['fileOnly']), 1);

		let removed = false;
		watcher.on('remove', () => {
			removed = true;
		});
		// The unlink-triggered merge drops the file-only key — an observable 'change'
		// that marks the unlink as processed without racing chokidar's latency.
		const changed = new Promise((resolve) => watcher.on('change', resolve));
		rmSync(filePath, { force: true });
		await changed;

		assert.strictEqual(removed, false, 'env-defined scope must survive the file deletion');
		assert.strictEqual(watcher.get(['enabled']), true, 'env value must remain in effect');
		assert.strictEqual(watcher.get(['fileOnly']), undefined, 'file-contributed value goes away with the file');
	});
});
