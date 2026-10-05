'use strict';
const assert = require('node:assert');
const pools = () => require('#src/server/threads/workerPools');
const iso = () => require('#src/server/threads/isolatedApplications');

describe('dedicated worker pools', () => {
	describe('shouldBindListenerHere', () => {
		const active = ['replication'];
		it('binds only its own type’s listeners on a pool worker', () => {
			const { shouldBindListenerHere } = pools();
			assert.strictEqual(shouldBindListenerHere('9933', 'replication', 'replication', active), true);
			assert.strictEqual(shouldBindListenerHere('9926', 'replication', undefined, active), false);
			assert.strictEqual(shouldBindListenerHere('/tmp/ops.sock', 'replication', undefined, active), false);
		});

		it('leaves an owned listener to its running pool', () => {
			const { shouldBindListenerHere } = pools();
			assert.strictEqual(shouldBindListenerHere('9933', 'http', 'replication', active), false);
			assert.strictEqual(shouldBindListenerHere('9933', undefined, 'replication', active), false);
			assert.strictEqual(shouldBindListenerHere('9926', 'http', undefined, active), true);
		});

		it('binds an owned listener as before when its pool is not running', () => {
			const { shouldBindListenerHere } = pools();
			assert.strictEqual(shouldBindListenerHere('9933', 'http', 'replication', []), true);
			assert.strictEqual(shouldBindListenerHere('9933', undefined, 'replication', []), true);
		});
	});

	describe('claimListener', () => {
		it('records the owner, keyed the same for a number and its string', () => {
			const { claimListener, listenerOwner } = pools();
			claimListener(19933, 'replication');
			claimListener('19933', 'replication');
			assert.strictEqual(listenerOwner('19933'), 'replication');
			assert.strictEqual(listenerOwner(19933), 'replication');
		});

		it('refuses a type that is not a dedicated pool', () => {
			assert.throws(() => pools().claimListener(19934, 'replicaton'), /Unknown listener threadType/);
			// HTTP workers bind unowned listeners already; owning one by 'http' would mean nothing
			assert.throws(() => pools().claimListener(19934, 'http'), /Unknown listener threadType/);
		});
	});

	describe('admittedWorkerPools', () => {
		const env = () => require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const settings = {
			[CONFIG_PARAMS.REPLICATION_THREADS]: undefined,
			[CONFIG_PARAMS.REPLICATION_PORT]: undefined,
			[CONFIG_PARAMS.REPLICATION_SECUREPORT]: undefined,
			[CONFIG_PARAMS.HTTP_PORT]: undefined,
			[CONFIG_PARAMS.HTTP_SECUREPORT]: undefined,
			[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: undefined,
			[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT]: undefined,
		};
		const saved = {};
		before(() => {
			for (const key in settings) saved[key] = env().get(key);
		});
		afterEach(() => {
			for (const key in saved) env().setProperty(key, saved[key]);
		});
		const configure = (values) => {
			for (const key in settings) env().setProperty(key, values[key] ?? null);
		};
		const admitted = () => require('#src/server/threads/socketRouter').admittedWorkerPools();

		it('starts no pool by default', () => {
			configure({ [CONFIG_PARAMS.REPLICATION_SECUREPORT]: 9933 });
			assert.deepStrictEqual(admitted(), []);
		});

		it('admits the configured replication pool', () => {
			configure({
				[CONFIG_PARAMS.REPLICATION_THREADS]: 2,
				[CONFIG_PARAMS.REPLICATION_SECUREPORT]: '127.0.0.1:9933',
				[CONFIG_PARAMS.HTTP_PORT]: 9926,
				[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925,
			});
			assert.deepStrictEqual(admitted(), [{ type: 'replication', count: 2 }]);
		});

		it('refuses a pool with no replication port of its own', () => {
			configure({ [CONFIG_PARAMS.REPLICATION_THREADS]: 2, [CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925 });
			assert.throws(admitted, /requires replication\.port or replication\.securePort/);
		});

		it('refuses a replication port shared with HTTP or the operations API', () => {
			configure({
				[CONFIG_PARAMS.REPLICATION_THREADS]: 1,
				[CONFIG_PARAMS.REPLICATION_SECUREPORT]: '127.0.0.1:9925',
				[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925,
			});
			assert.throws(admitted, /port 9925 is also operationsApi\.network\.port/);
		});

		it('refuses a count that is not a non-negative integer', () => {
			configure({ [CONFIG_PARAMS.REPLICATION_THREADS]: 1.5, [CONFIG_PARAMS.REPLICATION_SECUREPORT]: 9933 });
			assert.throws(admitted, /non-negative integer/);
		});
	});

	it('loads no application on a pool worker', () => {
		const config = { shared: { package: 'x' }, isolatedApp: { package: 'x', isolated: true } };
		assert.strictEqual(iso().shouldLoadApplicationHere('shared', undefined, config, true), false);
		assert.strictEqual(iso().shouldLoadApplicationHere('isolatedApp', undefined, config, true), false);
		assert.strictEqual(iso().shouldLoadApplicationHere('shared', undefined, config, false), true);
	});
});
