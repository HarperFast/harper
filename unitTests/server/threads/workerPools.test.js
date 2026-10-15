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

	describe('server.http registration', () => {
		const http = () => require('#src/server/http');
		const env = () => require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

		it('claims the secure port and its UDS mirror for the owning type', () => {
			const before = env().get(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS);
			env().setProperty(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS, true);
			try {
				http().httpServer(() => {}, { securePort: 19936, threadType: 'replication' });
			} finally {
				env().setProperty(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS, before);
			}
			const { SERVERS } = require('#src/server/serverRegistry');
			const mirror = Object.keys(SERVERS).find((key) => key.endsWith('-19936.sock'));
			assert.ok(mirror, 'the secure port got a UDS mirror');
			assert.strictEqual(pools().listenerOwner(19936), 'replication');
			assert.strictEqual(pools().listenerOwner(mirror), 'replication', 'the mirror is owned with its port');
		});

		it('keeps owned and unowned listeners off each other’s ports', () => {
			http().httpServer(() => {}, { port: 19937, threadType: 'replication' });
			assert.throws(() => http().httpServer(() => {}, { port: 19937 }), /owned by 'replication' workers/);
			http().httpServer(() => {}, { port: 19938 });
			assert.throws(
				() => http().httpServer(() => {}, { port: 19938, threadType: 'replication' }),
				/already serves listeners on every worker/
			);
		});
	});

	describe('admittedWorkerPools', () => {
		const env = () => require('#src/utility/environment/environmentManager');
		const harperLogger = () => require('#src/utility/logging/harper_logger');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const settings = {
			[CONFIG_PARAMS.THREADS_COUNT]: undefined,
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
		const admitted = (httpThreadCount) =>
			require('#src/server/threads/socketRouter').admittedWorkerPools(httpThreadCount);
		const threadCount = (httpThreadCount) =>
			require('#src/server/threads/socketRouter').replicationThreadCount(httpThreadCount);

		it('defaults replication.threads to floor(threads.count / 2) for threads.count >= 2 and 0 otherwise', () => {
			configure({ [CONFIG_PARAMS.REPLICATION_SECUREPORT]: 9933 });
			const cases = [
				[0, 0],
				[1, 0],
				[2, 1],
				[3, 1],
				[4, 2],
				[5, 2],
				[8, 4],
			];
			for (const [httpThreads, expected] of cases) {
				assert.deepStrictEqual(threadCount(httpThreads), { count: expected, explicit: false });
				assert.deepStrictEqual(admitted(httpThreads), expected > 0 ? [{ type: 'replication', count: expected }] : []);
			}
		});

		it('honors explicit replication.threads: 0 even when threads.count >= 2', () => {
			configure({
				[CONFIG_PARAMS.THREADS_COUNT]: 4,
				[CONFIG_PARAMS.REPLICATION_THREADS]: 0,
				[CONFIG_PARAMS.REPLICATION_SECUREPORT]: 9933,
			});
			assert.deepStrictEqual(threadCount(4), { count: 0, explicit: true });
			assert.deepStrictEqual(admitted(4), []);
		});

		it('admits the explicitly configured replication pool', () => {
			configure({
				[CONFIG_PARAMS.REPLICATION_THREADS]: 2,
				[CONFIG_PARAMS.REPLICATION_SECUREPORT]: '127.0.0.1:9933',
				[CONFIG_PARAMS.HTTP_PORT]: 9926,
				[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925,
			});
			assert.deepStrictEqual(admitted(1), [{ type: 'replication', count: 2 }]);
		});

		it('refuses an explicitly configured pool with no replication port of its own', () => {
			configure({ [CONFIG_PARAMS.REPLICATION_THREADS]: 2, [CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925 });
			assert.throws(() => admitted(4), /requires replication\.port or replication\.securePort/);
		});

		it('falls back to 0 and warns when a defaulted pool has no dedicated replication port', () => {
			configure({ [CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925 });
			const warnings = [];
			const logger = harperLogger();
			const originalWarn = logger.warn;
			logger.warn = (...args) => warnings.push(args.join(' '));
			try {
				assert.deepStrictEqual(admitted(4), []);
			} finally {
				logger.warn = originalWarn;
			}
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /requires replication\.port or replication\.securePort/);
			assert.match(warnings[0], /falling back to replication\.threads: 0/);
		});

		it('refuses an explicitly configured replication port shared with HTTP or the operations API', () => {
			configure({
				[CONFIG_PARAMS.REPLICATION_THREADS]: 1,
				[CONFIG_PARAMS.REPLICATION_SECUREPORT]: '127.0.0.1:9925',
				[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925,
			});
			assert.throws(() => admitted(4), /port 9925 is also operationsApi\.network\.port/);
		});

		it('falls back to 0 and warns when a defaulted pool shares a port with HTTP or the operations API', () => {
			configure({
				[CONFIG_PARAMS.REPLICATION_SECUREPORT]: '127.0.0.1:9925',
				[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925,
			});
			const warnings = [];
			const logger = harperLogger();
			const originalWarn = logger.warn;
			logger.warn = (...args) => warnings.push(args.join(' '));
			try {
				assert.deepStrictEqual(admitted(4), []);
			} finally {
				logger.warn = originalWarn;
			}
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /port 9925 is also operationsApi\.network\.port/);
			assert.match(warnings[0], /falling back to replication\.threads: 0/);
		});

		it('refuses a count that is not a non-negative integer', () => {
			configure({ [CONFIG_PARAMS.REPLICATION_THREADS]: 1.5, [CONFIG_PARAMS.REPLICATION_SECUREPORT]: 9933 });
			assert.throws(() => admitted(4), /non-negative integer/);
		});
	});

	it('loads no application on a pool worker', () => {
		const config = { shared: { package: 'x' }, isolatedApp: { package: 'x', isolated: true } };
		assert.strictEqual(iso().shouldLoadApplicationHere('shared', undefined, config, true), false);
		assert.strictEqual(iso().shouldLoadApplicationHere('isolatedApp', undefined, config, true), false);
		assert.strictEqual(iso().shouldLoadApplicationHere('shared', undefined, config, false), true);
	});
});
