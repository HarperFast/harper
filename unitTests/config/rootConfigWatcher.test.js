const assert = require('node:assert/strict');
const { RootConfigWatcher } = require('../../config/RootConfigWatcher');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { replace, fake, restore, spy } = require('sinon');
const configUtils = require('../../config/configUtils');
const { stringify } = require('yaml');

describe('RootConfigWatcher', () => {
	beforeEach(() => {
		this.fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.root-config-watcher-'));
		this.configFilePath = join(this.fixture, 'config.yaml');
		replace(configUtils, 'getConfigFilePath', fake.returns(this.configFilePath));
	});

	afterEach(() => {
		restore();
		rmSync(this.fixture, { recursive: true, force: true });
	});

	it('should instantiate and watch the root Harper config file', async () => {
		const expected = { foo: 'bar' };
		writeFileSync(this.configFilePath, stringify(expected));
		const configWatcher = new RootConfigWatcher();

		assert.ok(
			configWatcher instanceof RootConfigWatcher,
			'RootConfigWatcher should be an instance of RootConfigWatcher'
		);
		assert.equal(configWatcher.config, undefined, 'RootConfigWatcher should not have a config property yet');

		const [actual] = await configWatcher.ready();

		assert.deepEqual(expected, actual, 'RootConfigWatcher should have a config property after ready() is called');

		expected.foo = 'baz';

		await writeFile(this.configFilePath, stringify(expected));

		const [updated] = await once(configWatcher, 'change');

		assert.deepEqual(updated, expected, 'RootConfigWatcher should emit a change event with the updated config');

		const closeSpy = spy();
		configWatcher.on('close', closeSpy);
		const closeReturn = configWatcher.close();

		assert.equal(closeSpy.callCount, 1, 'close() should emit a close event');
		assert.deepEqual(closeReturn, configWatcher, 'close() should return the instance of RootConfigWatcher');
		assert.equal(
			configWatcher.config,
			undefined,
			'RootConfigWatcher should not have a config property after close() is called'
		);
	});
});
