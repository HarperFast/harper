const { OptionsWatcher } = require('#src/components/OptionsWatcher');
const assert = require('node:assert');
const { once } = require('node:events');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { stringify } = require('yaml');

const NAME = 'static';

/**
 * The application mount an operator declared in the root config is overlaid on every read, so
 * `getAll()` is the one effective view of a plugin's config. Everything that resolves routing
 * (the Scope `server` proxy, EntryHandler, static, fastifyRoutes) reads through it.
 */
describe('OptionsWatcher application mount', () => {
	let fixture;
	let configFilePath;
	let watcher;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.options-watcher-mount-'));
		configFilePath = join(fixture, 'config.yaml');
	});

	afterEach(async () => {
		await watcher?.close();
		watcher = undefined;
		rmSync(fixture, { recursive: true, force: true });
	});

	async function open(config, mount) {
		writeFileSync(configFilePath, stringify(config), 'utf-8');
		watcher = new OptionsWatcher(NAME, configFilePath, undefined, false, mount);
		await watcher.ready;
		return watcher;
	}

	it('leaves config untouched when the application has no mount', async () => {
		await open({ [NAME]: { files: 'web/**', urlPath: 'assets' } });
		assert.deepEqual(watcher.getAll(), { files: 'web/**', urlPath: 'assets' });
	});

	it('composes the mount prefix onto the plugin urlPath', async () => {
		await open({ [NAME]: { files: 'web/**', urlPath: 'assets' } }, { urlPath: '/v1' });
		assert.deepEqual(watcher.getAll(), { files: 'web/**', urlPath: '/v1/assets/' });
	});

	it('mounts a plugin that declares no urlPath of its own', async () => {
		await open({ [NAME]: { files: 'web/**' } }, { urlPath: '/v1' });
		assert.deepEqual(watcher.getAll(), { files: 'web/**', urlPath: '/v1/' });
	});

	it('overrides a host the application shipped', async () => {
		await open({ [NAME]: { files: 'web/**', host: 'www.shipped.example' } }, { host: 'api.example.com' });
		assert.equal(watcher.getAll().host, 'api.example.com');
	});

	it('does not compound the prefix across re-reads of the config file', async () => {
		await open({ [NAME]: { files: 'web/**', urlPath: 'assets' } }, { urlPath: '/v1' });
		assert.equal(watcher.getAll().urlPath, '/v1/assets/');

		// an unrelated edit triggers a re-read; the mount is composed from the on-disk value each
		// time, so the prefix must not accumulate into '/v1/v1/assets/'
		const changed = once(watcher, 'change');
		await writeFile(configFilePath, stringify({ [NAME]: { files: 'web/**', urlPath: 'assets', extra: 1 } }), 'utf-8');
		await changed;

		assert.equal(watcher.getAll().urlPath, '/v1/assets/');
		assert.equal(watcher.getAll().extra, 1);
	});

	it('reports a mounted urlPath change with the composed value', async () => {
		await open({ [NAME]: { files: 'web/**', urlPath: 'assets' } }, { urlPath: '/v1' });

		const changed = once(watcher, 'change');
		await writeFile(configFilePath, stringify({ [NAME]: { files: 'web/**', urlPath: 'static-files' } }), 'utf-8');
		const [key, value] = await changed;

		assert.deepEqual(key, ['urlPath']);
		assert.equal(value, '/v1/static-files/');
		assert.equal(watcher.getAll().urlPath, '/v1/static-files/');
	});

	it('emits no change when an edit leaves the composed value the same', async () => {
		await open({ [NAME]: { files: 'web/**', urlPath: 'assets' } }, { urlPath: '/v1' });

		let changes = 0;
		watcher.on('change', () => changes++);
		// 'assets' and '/assets/' resolve to the same mounted path
		await writeFile(configFilePath, stringify({ [NAME]: { files: 'web/**', urlPath: '/assets/' } }), 'utf-8');
		await new Promise((resolve) => setTimeout(resolve, 250));

		assert.equal(changes, 0);
		assert.equal(watcher.getAll().urlPath, '/v1/assets/');
	});
});
