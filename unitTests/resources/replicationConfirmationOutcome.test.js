const assert = require('node:assert');
const { runInNewContext } = require('node:vm');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction, contextStorage } = require('#src/resources/transaction');
const {
	replicationConfirmation: rocksConfirmation,
	settleCommitCompletions,
} = require('#src/resources/DatabaseTransaction');
const { replicationConfirmation: lmdbConfirmation } = require('#src/resources/LMDBTransaction');
const { ReplicationConfirmationError, ServerError } = require('#src/utility/errors/hdbError');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/REST');
const { contentTypes } = require('#src/server/serverHelpers/contentTypes');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const registerConfirmation = isLMDB ? lmdbConfirmation : rocksConfirmation;

describe('Replication confirmation failure after a local commit', () => {
	let First, Second;
	let sequence = 0;
	const nextId = () => `confirmation-${sequence++}`;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		First = table({
			database: 'confirmation-outcome-first',
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		Second = table({
			database: 'confirmation-outcome-second',
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.notEqual(First.primaryStore.path, Second.primaryStore.path);
	});
	afterEach(() => registerConfirmation(undefined));

	function requestConfirmation(context) {
		let link = context.transaction;
		while (link.db?.path !== First.primaryStore.path) link = link.next;
		// LMDB's production registry is unregistered; these tests explicitly exercise its commit path.
		link.replicatedConfirmation = 1;
	}

	async function confirmedWrite(id) {
		const context = { replicatedConfirmation: 1 };
		return transaction(context, async () => {
			await First.put({ id });
			requestConfirmation(context);
		});
	}

	for (const exclusive of isLMDB ? [false, true] : [false]) {
		for (const synchronous of [false, true]) {
			it(`marks ${synchronous ? 'synchronous' : 'asynchronous'} confirmation failure${exclusive ? ' (exclusive LMDB)' : ''}`, async () => {
				const id = nextId();
				const failure = new ServerError('Replication confirmation timed out', 504);
				failure.code = 'PEER_TIMEOUT';
				failure.retryable = true;
				Object.freeze(failure);
				registerConfirmation(() => {
					if (synchronous) throw failure;
					return Promise.reject(failure);
				});
				const previousRisk = First.primaryStore.retryRisk;
				if (exclusive) First.primaryStore.retryRisk = 101;
				try {
					await assert.rejects(confirmedWrite(id), (error) => {
						assert.ok(error instanceof ReplicationConfirmationError);
						assert.strictEqual(error.cause, failure);
						assert.strictEqual(error.replicationUnconfirmed, true);
						assert.strictEqual(error.retryable, false);
						assert.strictEqual(error.statusCode, 504);
						assert.strictEqual(error.code, 'PEER_TIMEOUT');
						assert.strictEqual(error.message, failure.message);
						return true;
					});
					assert.strictEqual((await First.get(id)).id, id);
					assert.strictEqual(failure.replicationUnconfirmed, undefined);
				} finally {
					First.primaryStore.retryRisk = previousRisk;
				}
			});
		}
	}

	it('normalizes a primitive rejection', async () => {
		const id = nextId();
		registerConfirmation(() => Promise.reject('peer unavailable'));
		await assert.rejects(confirmedWrite(id), (error) => {
			assert.strictEqual(error.replicationUnconfirmed, true);
			assert.strictEqual(error.cause, 'peer unavailable');
			assert.strictEqual(error.statusCode, 500);
			return true;
		});
		assert.strictEqual((await First.get(id)).id, id);
	});

	it('preserves the public code and status of an error from another JavaScript realm', async () => {
		const failure = runInNewContext(`
			class ForeignConfirmationError extends Error {
				constructor() {
					super('Foreign peer failure');
					this.status = 504;
				}
			}
			new ForeignConfirmationError();
		`);
		assert.strictEqual(failure instanceof Error, false);
		registerConfirmation(() => Promise.reject(failure));
		await assert.rejects(confirmedWrite(nextId()), (error) => {
			assert.strictEqual(error.replicationUnconfirmed, true);
			assert.strictEqual(error.statusCode, 504);
			assert.strictEqual(error.code, 'ForeignConfirmationError');
			assert.strictEqual(error.cause, failure);
			return true;
		});
	});

	it('does not mark a shared error later thrown by a local operation', async () => {
		const failure = new ServerError('Shared failure', 504);
		registerConfirmation(() => Promise.reject(failure));
		await assert.rejects(confirmedWrite(nextId()), (error) => error.cause === failure);
		assert.strictEqual(failure.replicationUnconfirmed, undefined);
		await assert.rejects(
			async () =>
				transaction({}, () => {
					throw failure;
				}),
			(error) => error === failure && error.replicationUnconfirmed === undefined
		);
	});

	it('retains successful confirmation and the existing callback arguments', async () => {
		const id = nextId();
		const calls = [];
		registerConfirmation((databaseName, version, count) => calls.push({ databaseName, version, count }));
		await confirmedWrite(id);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].databaseName, First.primaryStore.rootStore.databaseName);
		assert.strictEqual(calls[0].count, 1);
		assert.ok(calls[0].version > 0);
		assert.strictEqual((await First.get(id)).id, id);
	});

	it('leaves a pre-submission feasibility refusal unmarked and unwritten', async function () {
		if (isLMDB) this.skip();
		const id = nextId();
		const failure = new ServerError('Confirmation count cannot be met', 400);
		let waiterCalled = false;
		rocksConfirmation(
			() => (waiterCalled = true),
			() => {
				throw failure;
			}
		);
		await assert.rejects(confirmedWrite(id), (error) => error === failure);
		assert.strictEqual(failure.replicationUnconfirmed, undefined);
		assert.strictEqual(waiterCalled, false);
		assert.equal(await First.get(id), null);
	});

	it('waits for a held second database before surfacing confirmation failure', async () => {
		const id = nextId();
		const gate = Promise.withResolvers();
		let entered = false;
		class Delayed extends Second {}
		Delayed.sourcedFrom({
			get() {},
			put() {
				entered = true;
				return gate.promise;
			},
		});
		let confirmationStarted = false;
		registerConfirmation(() => {
			confirmationStarted = true;
			throw new ServerError('Peer timeout', 504);
		});
		const context = { replicatedConfirmation: 1 };
		let settled = false;
		const committing = transaction(context, async () => {
			await First.put({ id });
			requestConfirmation(context);
			await Delayed.put({ id });
		}).then(
			() => {
				settled = true;
			},
			(error) => {
				settled = true;
				return error;
			}
		);
		try {
			await waitFor(() => entered && confirmationStarted);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(settled, false, 'confirmation must not interrupt the held local commit');
			gate.resolve();
			await waitFor(() => settled);
			const error = await committing;
			assert.strictEqual(error.replicationUnconfirmed, true);
			assert.strictEqual((await First.get(id)).id, id);
			assert.strictEqual((await Second.get(id)).id, id);
		} finally {
			gate.resolve();
			await waitFor(() => settled);
			await committing;
		}
	});

	for (const confirmation of [false, true]) {
		it(`surfaces a later local failure promptly${confirmation ? ' even when confirmation never settles' : ' without confirmation'}`, async () => {
			const id = nextId();
			const failure = new ServerError('Later source failed', 502);
			class Failing extends Second {}
			Failing.sourcedFrom({ get() {}, put: () => Promise.reject(failure) });
			let started = false;
			registerConfirmation(() => {
				started = true;
				return new Promise(() => {});
			});
			const context = confirmation ? { replicatedConfirmation: 1 } : {};
			let outcome;
			let settled = false;
			const committing = transaction(context, async () => {
				await First.put({ id });
				if (confirmation) requestConfirmation(context);
				await Failing.put({ id });
			}).then(
				() => (settled = true),
				(error) => {
					outcome = error;
					settled = true;
				}
			);
			await waitFor(() => settled);
			await committing;
			assert.strictEqual(outcome, failure);
			assert.strictEqual(outcome.replicationUnconfirmed, undefined);
			assert.strictEqual(started, confirmation);
			assert.strictEqual((await First.get(id)).id, id);
			assert.equal(await Second.get(id), null);
		});
	}

	it('defers a child confirmation failure until other local completions settle', async () => {
		const gate = Promise.withResolvers();
		const failure = new ReplicationConfirmationError(new ServerError('Child confirmation failed', 504));
		let settled = false;
		const completing = settleCommitCompletions([Promise.reject(failure), gate.promise]).catch((error) => {
			settled = true;
			return error;
		});
		try {
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(settled, false);
			gate.resolve();
			await waitFor(() => settled);
			assert.strictEqual(await completing, failure);
		} finally {
			gate.resolve();
		}
	});

	it('reports a local failure ahead of a child confirmation failure', async () => {
		const localFailure = new ServerError('Local flush failed', 500);
		const childFailure = new ReplicationConfirmationError(new ServerError('Child confirmation failed', 504));
		await assert.rejects(
			settleCommitCompletions([Promise.reject(childFailure), Promise.reject(localFailure)]),
			(error) => error === localFailure
		);
	});

	it('surfaces a child confirmation failure even if the parent waiter never settles', async () => {
		const id = nextId();
		const context = { replicatedConfirmation: 1 };
		registerConfirmation((databaseName) =>
			databaseName === First.primaryStore.rootStore.databaseName
				? new Promise(() => {})
				: Promise.reject(new ServerError('Child confirmation failed', 504))
		);
		let settled = false;
		let outcome;
		const committing = transaction(context, async () => {
			await First.put({ id });
			requestConfirmation(context);
			await Second.put({ id });
			let child = context.transaction;
			while (child.db?.path !== Second.primaryStore.path) child = child.next;
			child.replicatedConfirmation = 1;
		}).then(
			() => (settled = true),
			(error) => {
				settled = true;
				outcome = error;
			}
		);
		await waitFor(() => settled);
		await committing;
		assert.strictEqual(outcome.replicationUnconfirmed, true);
		assert.strictEqual(outcome.message, 'Child confirmation failed');
		assert.strictEqual((await First.get(id)).id, id);
		assert.strictEqual((await Second.get(id)).id, id);
	});

	it('removes a nested commit flag when the enclosing callback aborts pending writes', async () => {
		const id = nextId();
		registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
		await assert.rejects(
			transaction({}, async () => {
				await Second.put({ id: `outer-${id}` });
				await confirmedWrite(`inner-${id}`);
			}),
			(error) => {
				assert.strictEqual(error.replicationUnconfirmed, undefined);
				assert.strictEqual(error.cause.replicationUnconfirmed, true);
				assert.strictEqual(error.statusCode, 504);
				assert.strictEqual(error.code, 'ServerError');
				assert.strictEqual(error.retryable, false);
				return true;
			}
		);
		assert.strictEqual((await First.get(`inner-${id}`)).id, `inner-${id}`);
		assert.equal(await Second.get(`outer-${id}`), null);
	});

	it('retains a nested commit outcome before any later application step was issued', async () => {
		const id = nextId();
		let laterStepRan = false;
		registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
		await assert.rejects(
			transaction({}, async () => {
				await confirmedWrite(id);
				laterStepRan = true;
				await Second.put({ id: `later-${id}` });
			}),
			(error) => error.replicationUnconfirmed === true && error.retryable === false
		);
		assert.strictEqual(laterStepRan, false);
		assert.strictEqual((await First.get(id)).id, id);
		assert.equal(await Second.get(`later-${id}`), null);
	});

	it('preserves the flag when the callback awaited its own failed commit', async () => {
		const id = nextId();
		const context = { replicatedConfirmation: 1 };
		registerConfirmation(() => Promise.reject(new ServerError('Own peer timeout', 504)));
		await assert.rejects(
			transaction(context, async (scope) => {
				await First.put({ id });
				requestConfirmation(context);
				await scope.commit();
			}),
			(error) => error.replicationUnconfirmed === true
		);
		assert.strictEqual((await First.get(id)).id, id);
	});

	it('does not defer a foreign confirmation error from local pre-commit work', async () => {
		const id = nextId();
		registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
		class NestedSource extends Second {}
		NestedSource.sourcedFrom({ get() {}, put: () => confirmedWrite(`inner-source-${id}`) });
		await assert.rejects(
			transaction({}, () => NestedSource.put({ id: `outer-source-${id}` })),
			(error) => {
				assert.strictEqual(error.replicationUnconfirmed, undefined);
				assert.strictEqual(error.cause.replicationUnconfirmed, true);
				return true;
			}
		);
		assert.strictEqual((await First.get(`inner-source-${id}`)).id, `inner-source-${id}`);
		assert.equal(await Second.get(`outer-source-${id}`), null);
	});

	for (const rollback of [false, true]) {
		for (const type of ['application/json', 'application/x-ndjson', 'text/event-stream']) {
			it(`retains a post-commit confirmation flag in a terminal ${type} record${rollback ? ' after outer rollback' : ''}`, async () => {
				const id = nextId();
				registerConfirmation(() => Promise.reject(new ServerError('Stream peer timeout', 504)));
				async function* source() {
					yield { stage: 'before-write' };
					if (rollback) {
						await transaction({}, async () => {
							await Second.put({ id: `outer-stream-${id}` });
							await confirmedWrite(id);
						});
					} else await confirmedWrite(id);
				}
				const stream = contentTypes.get(type).serializeStream(source(), undefined, { method: 'GET' });
				const chunks = [];
				for await (const chunk of stream) chunks.push(Buffer.from(chunk));
				const text = Buffer.concat(chunks).toString();
				const records =
					type === 'application/json'
						? JSON.parse(text)
						: type === 'text/event-stream'
							? text
									.split('\n')
									.filter((line) => line.startsWith('data: '))
									.map((line) => JSON.parse(line.slice(6)))
							: text
									.trim()
									.split('\n')
									.map((line) => JSON.parse(line));
				assert.deepStrictEqual(records[0], { stage: 'before-write' });
				const failure = records[1].$harperStreamError ?? records[1];
				assert.strictEqual(failure.replicationUnconfirmed, rollback ? undefined : true);
				assert.strictEqual(failure.retryable, false);
				if (type === 'application/json')
					assert.match(failure.error, rollback ? /^ServerError:/ : /^ReplicationConfirmationError:/);
				else {
					assert.strictEqual(failure.error, 'ServerError');
					assert.strictEqual(failure.status, 504);
				}
				assert.strictEqual((await First.get(id)).id, id);
				if (rollback) assert.equal(await Second.get(`outer-stream-${id}`), null);
			});
		}
	}

	for (const rollback of [false, true]) {
		it(`publishes the REST outcome${rollback ? ' after outer rollback' : ''} while retaining the original public code`, async () => {
			const id = nextId();
			registerConfirmation(() => Promise.reject(new ServerError('Peer timeout', 504)));
			class Signup extends Resource {
				static loadAsInstance = false;
				async post(target) {
					if (rollback) {
						await Second.put({ id: `outer-rest-${target.id}` });
						await confirmedWrite(target.id);
					} else {
						await First.put({ id: target.id });
						requestConfirmation(contextStorage.getStore());
					}
					return 'created';
				}
			}
			const resources = new Resources();
			resources.set('Signup', Signup);
			let listener;
			handleApplication({
				resources,
				options: { getAll: () => ({ webSocket: false }) },
				routeFor: () => ({ urlPath: `/confirmation-outcome-${rollback}` }),
				server: { http: (handler) => (listener = handler) },
			});
			const response = await listener({
				method: 'POST',
				url: `/Signup/${id}`,
				pathname: `/Signup/${id}`,
				ip: '203.0.113.7',
				user: { username: 'admin', role: { permission: { super_user: true } } },
				headers: { asObject: {}, get: () => undefined },
			});
			assert.strictEqual(response.status, 504);
			const body = JSON.parse(response.body);
			assert.strictEqual(body.replicationUnconfirmed, rollback ? undefined : true);
			assert.strictEqual(body.retryable, false);
			assert.strictEqual(body.code, 'ServerError');
			assert.strictEqual(body.title, 'Peer timeout');
			assert.strictEqual((await First.get(id)).id, id);
			if (rollback) assert.equal(await Second.get(`outer-rest-${id}`), null);
		});
	}
});
