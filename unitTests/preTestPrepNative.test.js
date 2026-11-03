const assert = require('node:assert');
const { join } = require('node:path');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const realInit = env.initSync;
const { preTestPrep } = require('./testUtils');

describe('unit environment initialization', () => {
	it('preserves explicit configuration and storage isolation through real re-initialization', () => {
		preTestPrep({ keep_alive_timeout: 32123, server_timeout: 45678 });
		for (const force of [false, true]) {
			realInit(force);
			assert.strictEqual(env.get(CONFIG_PARAMS.HTTP_KEEPALIVETIMEOUT), 32123);
			assert.strictEqual(env.get(CONFIG_PARAMS.HTTP_TIMEOUT), 45678);
			assert.strictEqual(
				env.get(CONFIG_PARAMS.STORAGE_PATH),
				join(__dirname, 'envDir', String(process.pid), 'database')
			);
		}
	});
});
