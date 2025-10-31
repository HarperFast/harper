import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert/strict';
import { RootConfigWatcher } from '@/config/RootConfigWatcher';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { replace, fake, restore, spy } from 'sinon';
import { stringify } from 'yaml';

// require so we can use test doubles
const configUtils = require('@/config/configUtils');

describe('RootConfigWatcher', () => {
	let fixture: string;
	let configFilePath: string;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.root-config-watcher-'));
		configFilePath = join(fixture, 'config.yaml');
		replace(configUtils, 'getConfigFilePath', fake.returns(configFilePath));
	});

	afterEach(() => {
		restore();
		rmSync(fixture, { recursive: true, force: true });
	});

	it('should instantiate and watch the root Harper config file', async () => {
		const expected = { foo: 'bar' };
		writeFileSync(configFilePath, stringify(expected));
		const configWatcher = new RootConfigWatcher();

		assert.ok(
			configWatcher instanceof RootConfigWatcher,
			'RootConfigWatcher should be an instance of RootConfigWatcher'
		);
		assert.equal(configWatcher.config, undefined, 'RootConfigWatcher should not have a config property yet');

		const [actual] = await configWatcher.ready;

		assert.deepEqual(expected, actual, 'RootConfigWatcher should have a config property after ready() is called');

		expected.foo = 'baz';

		await writeFile(configFilePath, stringify(expected));

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
