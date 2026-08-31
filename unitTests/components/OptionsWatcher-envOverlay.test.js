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
const { DEFAULT_CONFIG } = require('#src/components/DEFAULT_CONFIG');
const { waitFor } = require('../waitFor');

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

	// Env config is file-independent, so the terminal outcomes that settle the boot barrier on the
	// defaults must not discard it either — the same invariant as the ENOENT read path.
	it('keeps env config when the watcher itself fails', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ http: { port: 9926 } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		watcher.on('error', () => {});
		watcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

		const [config] = await watcher.ready;
		assert.deepStrictEqual(config, { enabled: true });
	});

	// Env config that cannot be composed is not env config: the barrier still has to settle on the
	// defaults, not on `undefined` and not by rejection, or componentLoader waits on it forever.
	it('settles on the defaults when the env config itself cannot be composed and there is no file', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		process.env.HARPER_SET_CONFIG = '{not json';

		watcher = new OptionsWatcher(NAME, filePath);
		const errors = [];
		watcher.on('error', (error) => errors.push(error));

		const [config] = await watcher.ready;
		assert.strictEqual(config, undefined, 'a scope with no defaults settles carrying nothing');
		assert.deepStrictEqual(watcher.getRoot(), DEFAULT_CONFIG);
		assert.strictEqual(errors.length, 1, 'the compose failure must still be surfaced');
	});

	it('settles on the defaults when the env config cannot be composed and the file is empty', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, '');
		process.env.HARPER_SET_CONFIG = '{not json';

		watcher = new OptionsWatcher(NAME, filePath);
		watcher.on('error', () => {});

		await watcher.ready;
		assert.deepStrictEqual(watcher.getRoot(), DEFAULT_CONFIG, 'not undefined — a scope reading it would throw');
	}).timeout(10000);

	it('reports a malformed env config once when the root file is otherwise valid', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false } }));
		process.env.HARPER_SET_CONFIG = '{not json';

		watcher = new OptionsWatcher(NAME, filePath);
		const errors = [];
		watcher.on('error', (error) => errors.push(error));

		await watcher.ready;
		assert.strictEqual(errors.length, 1, 'the malformed env config is surfaced once');
		assert.deepStrictEqual(watcher.getRoot(), DEFAULT_CONFIG);
	});

	it('reports a malformed env config after the watcher is ready', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false } }));

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		const errors = [];
		watcher.on('error', (error) => errors.push(error));

		process.env.HARPER_SET_CONFIG = '{not json';
		writeFileSync(filePath, stringify({ [NAME]: { enabled: true } }));
		await watcher._refreshForTests();

		assert.strictEqual(errors.length, 1, 'the malformed env config is surfaced after ready');
		assert.strictEqual(watcher.get(['enabled']), false, 'the malformed overlay does not replace the last valid config');
	});

	// `#handleUnlink` runs inside chokidar's own dispatch, and the env-only fallback merges — so a
	// plugin's own `change` handler throwing would take the worker down on a config deletion the
	// watcher had just decided to survive.
	it('does not let a throwing change listener escape the env-only unlink fallback', async () => {
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false, fromFile: 1 } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['fromFile']), 1);

		let changes = 0;
		watcher.on('change', () => {
			changes++;
			throw new Error('listener boom');
		});
		rmSync(filePath);

		await waitFor(() => changes > 0, { message: 'the env-only fallback never merged' });
		assert.strictEqual(watcher.get(['enabled']), true, 'env config survives the deletion');
	}).timeout(10000);

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
	it('does not let the env overlay launder a root config that parses to nothing', async () => {
		// `overlayRootEnvConfig` turns any parse into a non-null object whenever a config env var
		// is set, so completeness has to be judged on the file's own parse — otherwise a truncated
		// write that yields `null` is adopted as an env-only config and the file's options go away.
		const filePath = join(dir, 'harper-config.yaml');
		writeFileSync(filePath, stringify({ [NAME]: { enabled: false, fileOnly: 1 } }));
		process.env.HARPER_SET_CONFIG = JSON.stringify({ [NAME]: { enabled: true } });

		watcher = new OptionsWatcher(NAME, filePath);
		await watcher.ready;
		assert.strictEqual(watcher.get(['fileOnly']), 1);

		let removed = false;
		watcher.on('remove', () => {
			removed = true;
		});
		// A lone newline reads fine and parses to null — the shape of a mid-write read that no
		// `catch` sees.
		writeFileSync(filePath, '\n');
		await watcher._refreshForTests();

		assert.strictEqual(removed, false, 'a mid-write read must not read as the scope being removed');
		assert.strictEqual(watcher.get(['fileOnly']), 1, 'the file-contributed value must survive');
	});
});
