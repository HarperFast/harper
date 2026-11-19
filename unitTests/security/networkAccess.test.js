'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	normalizeCidr,
	normalizeAllowList,
	addressIsAllowed,
	setNetworkAccess,
	getNetworkAccess,
	allowedSourcesFor,
	watchNetworkAccess,
	resetNetworkAccessWatches,
	runWithCallerAddress,
} = require('#src/security/networkAccess');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');
const opAuth = require('#src/utility/operation_authorization');

const TABLE = terms.SYSTEM_TABLE_NAMES.NETWORK_ACCESS_TABLE_NAME;

function installMockTable(rows = new Map()) {
	const subscriptions = [];
	const mock = {
		rows,
		subscriptions,
		gets: 0,
		async get(id) {
			mock.gets++;
			return rows.get(id);
		},
		async put(id, row) {
			rows.set(id, row);
		},
		async delete(id) {
			return rows.delete(id);
		},
		subscribe(options) {
			const subscription = { options, closed: false, listeners: {}, ended: false };
			subscription.on = (name, listener) => (subscription.listeners[name] = listener);
			subscription.end = () => (subscription.ended = true);
			subscriptions.push(subscription);
			return Promise.resolve(subscription);
		},
		notify() {
			for (const subscription of subscriptions) if (!subscription.ended) subscription.options.listener({ type: 'put' });
		},
	};
	const prior = databases.system[TABLE];
	databases.system[TABLE] = mock;
	return {
		mock,
		restore() {
			databases.system[TABLE] = prior;
		},
	};
}

const su = (operation, body = {}) => ({
	operation,
	hdb_user: { username: 'admin', role: { permission: { super_user: true } } },
	...body,
});
const delegated = (operation, body = {}) => ({
	operation,
	hdb_user: { username: 'joe', role: { permission: { super_user: false, operations: [operation] } } },
	...body,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, what, ms = 1000) {
	for (let i = 0; i < ms / 5; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe('networkAccess', () => {
	before(() => testUtils.ensureSystemTables());

	describe('normalizeCidr', () => {
		for (const [input, expected] of [
			['10.0.0.0/8', '10.0.0.0/8'],
			['192.168.1.7', '192.168.1.7/32'],
			['0.0.0.0/0', '0.0.0.0/0'],
			['10.1.2.3/8', '10.1.2.3/8'],
			['2001:DB8:0:0::/32', '2001:db8::/32'],
			['::1', '::1/128'],
			['::/0', '::/0'],
			['::FFFF:10.0.0.0/104', '10.0.0.0/8'],
			['::ffff:10.0.0.1', '10.0.0.1/32'],
			['::ffff:0:0/96', '0.0.0.0/0'],
			['::ffff:0:0/80', '::ffff:0.0.0.0/80'],
			['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1/128'],
			['2001:db8:0:1:0:0:0:1/64', '2001:db8:0:1::1/64'],
			['1:0:0:2:0:0:3:4', '1::2:0:0:3:4/128'],
			['1:0:2:3:4:5:6:7', '1:0:2:3:4:5:6:7/128'],
			['fe80::', 'fe80::/128'],
			['::1.2.3.4', '::102:304/128'],
		]) {
			it(`accepts ${input}`, () => assert.strictEqual(normalizeCidr(input), expected));
		}

		for (const input of [
			'',
			'10.0.0.0/33',
			'2001:db8::/129',
			'10.0.0.0/',
			'10.0.0.0/-1',
			'10.0.0.0/8/8',
			'10.0.0.0/+8',
			'10.0.0.0/ 8',
			' 10.0.0.1',
			'010.0.0.1',
			'256.0.0.1',
			'10.0.0',
			'fe80::1%eth0',
			'example.com',
			'10.0.0.0/8 ',
		]) {
			it(`rejects ${JSON.stringify(input)}`, () => assert.throws(() => normalizeCidr(input), { statusCode: 400 }));
		}

		it('rejects a non-string entry', () => {
			assert.throws(() => normalizeCidr(167772160), { statusCode: 400, message: /not a string/ });
			assert.throws(() => normalizeCidr(null), { statusCode: 400 });
		});

		it('collapses duplicates after normalizing', () => {
			assert.deepStrictEqual(normalizeAllowList(['10.0.0.1', '10.0.0.1/32', '2001:DB8::1', '2001:db8::1']), [
				'10.0.0.1/32',
				'2001:db8::1/128',
			]);
		});
	});

	describe('addressIsAllowed', () => {
		const allow = ['10.0.0.0/8', '2001:db8::/32', '192.168.1.7/32'];
		it('matches IPv4 and IPv6 addresses inside an entry', () => {
			assert.strictEqual(addressIsAllowed('10.200.3.4', allow), true);
			assert.strictEqual(addressIsAllowed('2001:db8:1::5', allow), true);
			assert.strictEqual(addressIsAllowed('192.168.1.7', allow), true);
		});
		it('rejects addresses outside every entry', () => {
			assert.strictEqual(addressIsAllowed('11.0.0.1', allow), false);
			assert.strictEqual(addressIsAllowed('192.168.1.8', allow), false);
			assert.strictEqual(addressIsAllowed('2001:db9::1', allow), false);
			assert.strictEqual(addressIsAllowed('not-an-ip', allow), false);
		});
		it('matches an IPv4-mapped IPv6 peer against an IPv4 entry', () => {
			assert.strictEqual(addressIsAllowed('::ffff:10.1.2.3', allow), true);
			assert.strictEqual(addressIsAllowed('0:0:0:0:0:FFFF:10.1.2.3', allow), true);
			assert.strictEqual(addressIsAllowed('::ffff:11.1.2.3', allow), false);
		});
		it('matches only entries of the address family, as the proxy does', () => {
			assert.strictEqual(addressIsAllowed('203.0.113.9', ['::/0']), false);
			assert.strictEqual(addressIsAllowed('::ffff:203.0.113.9', ['::/0']), false);
			assert.strictEqual(addressIsAllowed('2001:db8::1', ['0.0.0.0/0']), false);
			assert.strictEqual(addressIsAllowed('203.0.113.9', ['::/0', '0.0.0.0/0']), true);
		});
	});

	describe('operations', () => {
		let installed;
		beforeEach(() => {
			installed = installMockTable();
		});
		afterEach(() => installed.restore());
		const local = (request) => runWithCallerAddress(undefined, () => setNetworkAccess(request));

		it('registers both operations as super_user-only', () => {
			const user = (permission) => ({ username: 'joe', role: { role: 'r', permission } });
			for (const [operation, fn] of [
				['set_network_access', setNetworkAccess],
				['get_network_access', getNetworkAccess],
			]) {
				const verdict = (permission) => opAuth.verifyPerms({ operation, hdb_user: user(permission) }, fn);
				assert.ok(verdict({ super_user: false }), `${operation} is refused to a non-super user`);
				assert.strictEqual(verdict({ super_user: true }) ?? null, null, `${operation} is allowed to a super user`);
			}
		});

		it('refuses a non-super user even when a role delegates the operation', async () => {
			await assert.rejects(
				setNetworkAccess(delegated('set_network_access', { scope: 'operations', allow: ['10.0.0.0/8'] })),
				{ statusCode: 403 }
			);
			await assert.rejects(getNetworkAccess(delegated('get_network_access')), { statusCode: 403 });
			assert.strictEqual(installed.mock.rows.size, 0);
		});

		it('stores the normalized list with audit fields', async () => {
			const result = await local(
				su('set_network_access', { scope: 'operations', allow: ['10.0.0.0/8', '2001:DB8::/32'] })
			);
			assert.deepStrictEqual(result.allow, ['10.0.0.0/8', '2001:db8::/32']);
			const row = installed.mock.rows.get('operations');
			assert.deepStrictEqual(row.allow, ['10.0.0.0/8', '2001:db8::/32']);
			assert.strictEqual(row.scope, 'operations');
			assert.strictEqual(row.updatedBy, 'admin');
			assert.strictEqual(typeof row.updatedAt, 'number');
		});

		it('rejects the whole request when any entry is invalid', async () => {
			await assert.rejects(
				setNetworkAccess(su('set_network_access', { scope: 'operations', allow: ['10.0.0.0/8', '10.0.0.0/40'] })),
				{ statusCode: 400, message: /10\.0\.0\.0\/40/ }
			);
			assert.strictEqual(installed.mock.rows.size, 0);
		});

		it('rejects an unknown or missing scope, a non-array allow, and an oversized list', async () => {
			for (const body of [
				{ scope: 'http', allow: [] },
				{ allow: [] },
				{ scope: 'operations' },
				{ scope: 'operations', allow: '10.0.0.0/8' },
				{ scope: 'operations', allow: Array.from({ length: 1001 }, (_, i) => `10.0.${i >> 8}.${i & 255}`) },
			]) {
				await assert.rejects(
					setNetworkAccess(su('set_network_access', body)),
					{ statusCode: 400 },
					JSON.stringify(body)
				);
			}
		});

		it('removes the row for an empty list', async () => {
			installed.mock.rows.set('operations', { scope: 'operations', allow: ['10.0.0.0/8'] });
			await setNetworkAccess(su('set_network_access', { scope: 'operations', allow: [] }));
			assert.strictEqual(installed.mock.rows.has('operations'), false);
		});

		describe('lockout check', () => {
			const body = (extra) => su('set_network_access', { scope: 'operations', allow: ['10.0.0.0/8'], ...extra });
			const as = (address, request) => runWithCallerAddress(address, () => setNetworkAccess(request));

			it('refuses a list that excludes the caller address', async () => {
				await assert.rejects(as('203.0.113.9', body()), { statusCode: 409, message: /203\.0\.113\.9/ });
				assert.strictEqual(installed.mock.rows.size, 0);
			});

			it('refuses an IPv6-only list for an IPv4 caller', async () => {
				await assert.rejects(as('203.0.113.9', body({ allow: ['::/0'] })), { statusCode: 409 });
			});

			it('accepts a list that includes the caller, IPv4-mapped included', async () => {
				await as('10.9.9.9', body());
				await as('::ffff:10.9.9.9', body());
				assert.deepStrictEqual(installed.mock.rows.get('operations').allow, ['10.0.0.0/8']);
			});

			it('accepts an excluding list with force: true', async () => {
				await as('203.0.113.9', body({ force: true }));
				assert.ok(installed.mock.rows.has('operations'));
			});

			it('rejects a non-boolean force rather than reading it as an override', async () => {
				await assert.rejects(as('203.0.113.9', body({ force: 'true' })), { statusCode: 400 });
				assert.strictEqual(installed.mock.rows.size, 0);
			});

			it('requires force when a network request carried no address', async () => {
				await assert.rejects(as(null, body()), { statusCode: 409, message: /unknown/ });
				assert.strictEqual(installed.mock.rows.size, 0);
				await as(null, body({ force: true }));
				assert.ok(installed.mock.rows.has('operations'));
			});

			it('skips the check only for the local operations domain socket', async () => {
				await as(undefined, body());
				assert.ok(installed.mock.rows.has('operations'));
			});

			it('requires force for a call with no caller context (MCP, server.operation())', async () => {
				await assert.rejects(setNetworkAccess(body()), { statusCode: 409, message: /unknown/ });
				await setNetworkAccess(body({ force: true }));
				assert.ok(installed.mock.rows.has('operations'));
			});

			it('ignores an address supplied in the operation body', async () => {
				await assert.rejects(as('203.0.113.9', body({ hdb_client_address: '10.0.0.1' })), { statusCode: 409 });
			});

			it('does not check or warn when clearing the list', async () => {
				const result = await as('1.1.1.1', su('set_network_access', { scope: 'operations', allow: [] }));
				assert.strictEqual(result.warning, undefined);
			});

			it('warns that peers through the proxy must be listed, alongside the no-metadata warning', async () => {
				for (const result of [await as(undefined, body()), await as('203.0.113.9', body({ force: true }))]) {
					assert.match(result.warning, /tls\.unixDomainSockets/);
					assert.match(result.warning, /replication peers/);
				}
			});
		});

		it('gets one scope, or every scope, with an empty list where no row exists', async () => {
			assert.deepStrictEqual(await getNetworkAccess(su('get_network_access', { scope: 'operations' })), {
				scope: 'operations',
				allow: [],
				updatedBy: null,
				updatedAt: null,
			});
			installed.mock.rows.set('operations', {
				scope: 'operations',
				allow: ['10.0.0.0/8'],
				updatedBy: 'admin',
				updatedAt: 5,
			});
			assert.deepStrictEqual(await getNetworkAccess(su('get_network_access')), [
				{ scope: 'operations', allow: ['10.0.0.0/8'], updatedBy: 'admin', updatedAt: 5 },
			]);
			await assert.rejects(getNetworkAccess(su('get_network_access', { scope: 'mqtt' })), { statusCode: 400 });
		});
	});

	describe('watchNetworkAccess', () => {
		let installed;
		beforeEach(() => {
			resetNetworkAccessWatches(20);
			installed = installMockTable();
		});
		afterEach(() => {
			resetNetworkAccessWatches();
			installed.restore();
		});

		it('publishes only once the list has been read, then on every change', async () => {
			installed.mock.rows.set('operations', { allow: ['10.0.0.0/8'] });
			assert.strictEqual(allowedSourcesFor('operations'), undefined);
			const published = [];
			watchNetworkAccess('operations', () => {
				published.push(allowedSourcesFor('operations'));
				return true;
			});
			assert.deepStrictEqual(published, [], 'nothing is published before the first read');
			await until(() => published.length === 1, 'the first publication');
			assert.deepStrictEqual(published, [['10.0.0.0/8']]);
			assert.strictEqual(installed.mock.subscriptions[0].options.id, 'operations');

			installed.mock.rows.delete('operations');
			installed.mock.notify();
			await until(() => published.length === 2, 'the cleared publication');
			assert.deepStrictEqual(published[1], []);
		});

		it('treats a node without the table as unrestricted', async () => {
			installed.restore();
			const prior = databases.system[TABLE];
			delete databases.system[TABLE];
			try {
				let calls = 0;
				watchNetworkAccess('operations', () => ++calls > 0);
				await until(() => calls === 1, 'publication');
				assert.deepStrictEqual(allowedSourcesFor('operations'), []);
			} finally {
				databases.system[TABLE] = prior;
				installed = installMockTable();
			}
		});

		it('retries a failed publication on the periodic re-read without another change', async () => {
			installed.mock.rows.set('operations', { allow: ['10.0.0.0/8'] });
			let attempts = 0;
			watchNetworkAccess('operations', () => ++attempts >= 3);
			await until(() => attempts === 3, 'the retried publication');
			const settled = attempts;
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.strictEqual(attempts, settled, 'a successful publication is not repeated');
		});

		it('re-reads after a change that lands during a read, never publishing the older snapshot last', async () => {
			let releaseFirst;
			const firstRead = new Promise((resolve) => (releaseFirst = resolve));
			const realGet = installed.mock.get;
			let reads = 0;
			installed.mock.get = async (id) => {
				reads++;
				if (reads === 1) {
					await firstRead;
					return { allow: ['10.0.0.0/8'] };
				}
				return realGet(id);
			};
			installed.mock.rows.set('operations', { allow: ['192.168.0.0/16'] });
			const published = [];
			watchNetworkAccess('operations', () => {
				published.push(allowedSourcesFor('operations'));
				return true;
			});
			await settle();
			installed.mock.notify();
			releaseFirst();
			await until(() => reads === 2 && published.length > 0, 'the second read');
			await until(() => published.at(-1)?.[0] === '192.168.0.0/16', 'the newer list');
			assert.deepStrictEqual(allowedSourcesFor('operations'), ['192.168.0.0/16']);
		});

		it('survives a synchronous subscribe throw and recovers on the periodic re-read', async () => {
			const realSubscribe = installed.mock.subscribe;
			installed.mock.subscribe = () => {
				throw new Error('database is closing');
			};
			installed.mock.rows.set('operations', { allow: ['10.0.0.0/8'] });
			const published = [];
			watchNetworkAccess('operations', () => {
				published.push(allowedSourcesFor('operations'));
				return true;
			});
			await until(() => published.length === 1, 'publication despite the failed subscribe');
			installed.mock.subscribe = realSubscribe;
			await until(() => installed.mock.subscriptions.length === 1, 'the retried subscription');
			installed.mock.rows.set('operations', { allow: ['192.168.0.0/16'] });
			installed.mock.notify();
			await until(() => published.at(-1)?.[0] === '192.168.0.0/16', 'the newer list');
		});

		describe('without the periodic re-read', () => {
			beforeEach(() => resetNetworkAccessWatches(3_600_000));

			it('resubscribes soon after its subscription closes', async () => {
				let calls = 0;
				watchNetworkAccess('operations', () => ++calls > 0);
				await until(() => installed.mock.subscriptions[0]?.listeners.close, 'subscription');
				installed.mock.subscriptions[0].listeners.close();
				await until(() => installed.mock.subscriptions.length === 2, 'resubscription', 2000);
			});

			it('reruns at once when a signal arrives during a read that fails', async () => {
				let reads = 0;
				let failFirst;
				const firstRead = new Promise((_, reject) => (failFirst = reject));
				installed.mock.rows.set('operations', { allow: ['10.0.0.0/8'] });
				const realGet = installed.mock.get;
				installed.mock.get = (id) => (++reads === 1 ? firstRead : realGet(id));
				const published = [];
				watchNetworkAccess('operations', () => {
					published.push(allowedSourcesFor('operations'));
					return true;
				});
				await settle();
				installed.mock.notify();
				failFirst(new Error('transient'));
				await until(() => published.length === 1, 'the rerun read');
				assert.deepStrictEqual(published, [['10.0.0.0/8']]);
			});
		});
	});
});
