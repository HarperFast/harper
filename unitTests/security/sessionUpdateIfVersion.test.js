const assert = require('node:assert');
const { Headers } = require('#src/server/serverHelpers/Headers');
const testUtils = require('../testUtils.js');
const { databases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { authentication } = require('#src/security/auth');
const { VERSION_REUSED } = require('#src/resources/RecordEncoder');
const { claimLocalKey } = require('#src/resources/originClosedFloor');
const { readLocalIssuanceCeiling } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor.js');

testUtils.preTestPrep();

describe('session.update ifVersion (HarperFast/harper#2983)', function () {
	let Sessions;

	before(async function () {
		testUtils.setupTestDBPath();
		await testUtils.ensureSystemTables();
		Sessions = databases.system.hdb_session;
	});

	function newRequest(cookie) {
		return {
			headers: { asObject: { authorization: null, cookie, origin: null, host: 'localhost' } },
			method: 'GET',
			pathname: '/test',
			ip: '192.0.2.1',
			isOperationsServer: false,
			mtlsConfig: null,
			authorized: false,
			peerCertificate: null,
			protocol: 'https',
		};
	}

	function newResponse() {
		return { status: 200, headers: new Headers(), body: '{}' };
	}

	async function establishSession(greeting = 'hello') {
		const response = newResponse();
		await authentication(newRequest(null), async (request) => {
			await request.session.update({ greeting });
			return response;
		});
		const setCookie = response.headers.get('Set-Cookie');
		assert.ok(setCookie, 'expected a session cookie');
		return setCookie.split(';')[0];
	}

	const conflict = (error) => {
		assert.strictEqual(error.code, 'VERSION_CONFLICT');
		assert.strictEqual(error.statusCode, 409);
		return true;
	};

	it('exposes the initially loaded version without persisting it in session data', async function () {
		const cookie = await establishSession();
		await authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(typeof request.session.version, 'number');
			assert.ok(!('version' in { ...request.session }));
			const version = request.session.version;
			await request.session.update({ greeting: 'updated' }, { ifVersion: version });
			assert.strictEqual(request.session.version, version, 'the getter describes the initial load');
			return newResponse();
		});
		await authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.greeting, 'updated');
			return newResponse();
		});
	});

	for (const change of ['update', 'logout', 'delete', 'remove']) {
		it(`rejects a refresh after a concurrent ${change}, bypassing the retained snapshot`, async function () {
			const cookie = await establishSession();
			const response = newResponse();
			await transaction({}, async () => {
				await authentication(newRequest(cookie), async (request) => {
					const { id, version } = request.session;
					assert.strictEqual((await Sessions.get(id)).greeting, 'hello');
					if (change === 'delete') await Sessions.delete(id, {});
					else if (change === 'remove') await Sessions.primaryStore.remove(id);
					else
						await authentication(newRequest(cookie), async (otherRequest) => {
							await otherRequest.session.update(change === 'logout' ? { user: null } : { greeting: 'winner' });
							return newResponse();
						});
					assert.strictEqual((await Sessions.get(id)).greeting, 'hello', 'the request snapshot is still old');
					const attempted = { greeting: 'stale refresh' };
					await assert.rejects(request.session.update(attempted, { ifVersion: version }), (error) => {
						assert.ok(!error.message.includes(id), 'the error must not expose the bearer cookie');
						assert.strictEqual(error.retryable, true);
						return conflict(error);
					});
					assert.deepStrictEqual(attempted, { greeting: 'stale refresh' }, 'rejection does not mutate input');
					return response;
				});
			});
			assert.strictEqual(response.headers.get('X-Hdb-Session'), undefined);
			await authentication(newRequest(cookie), async (request) => {
				assert.strictEqual(request.session.greeting, change === 'update' ? 'winner' : undefined);
				if (change === 'logout') assert.strictEqual(request.session.user, null);
				return newResponse();
			});
		});
	}

	it('renews the LMDB reader after a worker commits without yielding the calling thread', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') this.skip();
		const { Worker } = require('node:worker_threads');
		const cookie = await establishSession();
		const id = cookie.slice(cookie.indexOf('=') + 1);
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(require.resolve('./fixtures/sessionDeleteWorker.ts'), {
			workerData: {
				path: Sessions.primaryStore.path,
				name: Sessions.primaryStore.name,
				id,
				gate: gate.buffer,
				noServerStart: true,
			},
			execArgv: [],
		});
		let workerError;
		worker.on('error', (error) => {
			workerError = error;
		});
		try {
			await waitFor(() => {
				if (workerError) throw workerError;
				return Atomics.load(gate, 0) === 1;
			}, 10000);
			await authentication(newRequest(cookie), async (request) => {
				const version = request.session.version;
				assert.strictEqual(Sessions.primaryStore.getEntry(id).version, version);
				Atomics.store(gate, 0, 2);
				Atomics.notify(gate, 0);
				assert.notStrictEqual(Atomics.wait(gate, 0, 2, 10000), 'timed-out', 'the worker committed');
				assert.strictEqual(Atomics.load(gate, 0), 3);
				await assert.rejects(request.session.update({ greeting: 'revived' }, { ifVersion: version }), conflict);
				return newResponse();
			});
		} finally {
			await worker.terminate();
		}
	});

	it('rejects an expired session without extending its lifetime', async function () {
		const cookie = await establishSession();
		const id = cookie.slice(cookie.indexOf('=') + 1);
		const expiresAt = Date.now() + 1000;
		await Sessions.put({ id, greeting: 'expiring' }, { expiresAt });
		await authentication(newRequest(cookie), async (request) => {
			const version = request.session.version;
			await waitFor(() => Date.now() > expiresAt, 3000);
			await assert.rejects(request.session.update({ greeting: 'revived' }, { ifVersion: version }), conflict);
			assert.strictEqual(Sessions.primaryStore.getEntry(id)?.expiresAt, expiresAt);
			return newResponse();
		});
	});

	it('rejects a matching future-dated version before reporting an update', async function () {
		const cookie = await establishSession();
		const id = cookie.slice(cookie.indexOf('=') + 1);
		const future = Date.now() + 60000;
		await Sessions.put({ id, greeting: 'future' }, { timestamp: future });
		const response = newResponse();
		await authentication(newRequest(cookie), async (request) => {
			assert.ok(request.session.version >= future);
			await assert.rejects(
				request.session.update({ greeting: 'dropped' }, { ifVersion: request.session.version }),
				(error) => {
					assert.strictEqual(error.retryable, true);
					return conflict(error);
				}
			);
			return response;
		});
		assert.strictEqual(response.headers.get('X-Hdb-Session'), undefined);
		assert.strictEqual((await Sessions.get(id)).greeting, 'future');
	});

	it('accepts versions from a local issuance floor and rejects versions above it', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const root = Sessions.primaryStore.rootStore;
		const parent = { timestamp: root.getMonotonicTimestamp() };
		const floor = claimLocalKey(root, root.getMonotonicTimestamp() + 1000);
		try {
			const cookie = await establishSession();
			const id = cookie.slice(cookie.indexOf('=') + 1);
			const response = newResponse();
			let loadedVersion;
			await transaction(parent, () =>
				authentication(newRequest(cookie), async (request) => {
					assert.strictEqual(parent.transaction.timestamp, parent.timestamp);
					loadedVersion = request.session.version;
					assert.ok(loadedVersion > floor, 'the claim raised the clock the version came from');
					assert.ok(loadedVersion < root.getMonotonicTimestamp(), 'the next local write is above the version');
					await request.session.update({ greeting: 'locally issued' }, { ifVersion: loadedVersion });
					return response;
				})
			);
			const saved = await Sessions.get(id);
			assert.strictEqual(saved.greeting, 'locally issued');
			assert.ok(saved.getUpdatedTime() > loadedVersion);
			assert.strictEqual(response.headers.get('X-Hdb-Session'), 'Secure');

			await Sessions.put({ id, greeting: 'beyond local issuance' }, { timestamp: floor + 60000 });
			const rejectedResponse = newResponse();
			await authentication(newRequest(cookie), async (request) => {
				const version = request.session.version;
				assert.ok(version > root.getMonotonicTimestamp());
				await assert.rejects(request.session.update({ greeting: 'discarded' }, { ifVersion: version }), conflict);
				return rejectedResponse;
			});
			assert.strictEqual(rejectedResponse.headers.get('X-Hdb-Session'), undefined);
			assert.strictEqual((await Sessions.get(id)).greeting, 'beyond local issuance');
		} finally {
			await waitFor(() => root.getMonotonicTimestamp() > readLocalIssuanceCeiling(root.auditStore), 30000);
		}
	});

	it('reports application-owned numeric version data as a non-retryable conflict', async function () {
		const cookie = await establishSession();
		const id = cookie.slice(cookie.indexOf('=') + 1);
		await Sessions.put({ id, greeting: 'application', version: 7 });
		const response = newResponse();
		const update = { greeting: 'discarded' };
		await authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.version, 7);
			await assert.rejects(request.session.update(update, { ifVersion: request.session.version }), (error) => {
				assert.strictEqual(error.retryable, false);
				assert.ok(error.message.includes('reserved version'));
				assert.ok(!error.message.includes(id));
				return conflict(error);
			});
			return response;
		});
		assert.deepStrictEqual(update, { greeting: 'discarded' });
		assert.strictEqual(response.headers.get('X-Hdb-Session'), undefined);
		const saved = await Sessions.get(id);
		assert.strictEqual(saved.version, 7);
		assert.strictEqual(saved.greeting, 'application');
	});

	it('rejects a genuinely reused version even when its number matches', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const cookie = await establishSession();
		const id = cookie.slice(cookie.indexOf('=') + 1);
		const now = Date.now();
		await Sessions.patch(id, { greeting: 'newer' }, { timestamp: now + 100 });
		await Sessions.patch(id, { another: true }, { timestamp: now + 50 });
		assert.ok(Sessions.primaryStore.getEntry(id).metadataFlags & VERSION_REUSED);
		await authentication(newRequest(cookie), async (request) => {
			await assert.rejects(
				request.session.update({ greeting: 'lost' }, { ifVersion: request.session.version }),
				(error) => {
					assert.strictEqual(error.retryable, false);
					return conflict(error);
				}
			);
			return newResponse();
		});
	});

	it('rejects a cookie-less conditional update without minting a cookie', async function () {
		const response = newResponse();
		await authentication(newRequest(null), async (request) => {
			await assert.rejects(request.session.update({ greeting: 'x' }, { ifVersion: 1 }), conflict);
			return response;
		});
		assert.strictEqual(response.headers.get('Set-Cookie'), undefined);
		assert.strictEqual(response.headers.get('X-Hdb-Session'), undefined);
	});

	it('rejects unusable explicit conditions without falling back to an unconditional update', async function () {
		const cookie = await establishSession();
		await authentication(newRequest(cookie), async (request) => {
			for (const options of [
				null,
				{},
				1,
				{ ifVersion: undefined },
				{ ifVersion: null },
				{ ifVersion: NaN },
				{ ifVersion: Infinity },
			])
				assert.throws(() => request.session.update({ greeting: 'invalid' }, options), { statusCode: 400 });
			return newResponse();
		});
	});

	it('keeps updates without options unconditional and sends the success header', async function () {
		const cookie = await establishSession();
		const response = newResponse();
		await authentication(newRequest(cookie), async (request) => {
			await request.session.update({ greeting: 'unconditional' });
			return response;
		});
		assert.strictEqual(response.headers.get('X-Hdb-Session'), 'Secure');
	});

	it('preserves application-owned version data and assignments to the metadata accessor', async function () {
		const cookie = await establishSession();
		await authentication(newRequest(cookie), async (request) => {
			request.session.version = 'application version';
			assert.strictEqual(request.session.version, 'application version');
			assert.ok(Object.keys(request.session).includes('version'));
			await request.session.update({ ...request.session });
			return newResponse();
		});
		await authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.version, 'application version');
			assert.strictEqual({ ...request.session }.version, 'application version');
			return newResponse();
		});
	});

	it('keeps the success header when a conditional update is not awaited by the handler', async function () {
		const cookie = await establishSession();
		let pendingUpdate;
		const response = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
		await authentication(newRequest(cookie), (request) => {
			pendingUpdate = request.session.update({ greeting: 'unawaited' }, { ifVersion: request.session.version });
			return response;
		});
		try {
			assert.strictEqual(response.headers.get('X-Hdb-Session'), 'Secure');
		} finally {
			await pendingUpdate;
		}
	});

	it('keeps metadata when assigning version fails on a frozen session', async function () {
		const cookie = await establishSession();
		await authentication(newRequest(cookie), (request) => {
			const version = request.session.version;
			Object.freeze(request.session);
			assert.throws(() => {
				request.session.version = 'replacement';
			}, TypeError);
			assert.strictEqual(request.session.version, version);
			return newResponse();
		});
	});

	it('sets the success header for an awaited conditional update', async function () {
		const cookie = await establishSession();
		const response = newResponse();
		await authentication(newRequest(cookie), async (request) => {
			await request.session.update({ greeting: 'conditional' }, { ifVersion: request.session.version });
			return response;
		});
		assert.strictEqual(response.headers.get('X-Hdb-Session'), 'Secure');
	});
});
