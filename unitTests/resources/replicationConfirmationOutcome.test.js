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

	for (const property of ['message', 'statusCode', 'code', 'constructor', 'http_resp_msg', 'detail']) {
		it(`retains the committed outcome when the confirmation error's ${property} getter throws`, async () => {
			const id = nextId();
			const failure = new ServerError('Peer failure', 504);
			Object.defineProperty(failure, property, {
				get() {
					throw new Error('Error metadata is unreadable');
				},
			});
			registerConfirmation(() => Promise.reject(failure));
			await assert.rejects(confirmedWrite(id), (error) => {
				assert.ok(error instanceof ReplicationConfirmationError);
				assert.strictEqual(error.cause, failure);
				assert.strictEqual(error.replicationUnconfirmed, true);
				assert.strictEqual(error.retryable, false);
				return true;
			});
			assert.strictEqual((await First.get(id)).id, id);
		});
	}

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

	it('keeps a nested committed outcome after aborting an empty read-only scope', async () => {
		const id = nextId();
		registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
		await assert.rejects(
			transaction({}, async (scope) => {
				await Second.get(`absent-${id}`);
				assert.strictEqual(scope.hasPendingWrites(), false);
				scope.abort();
				await confirmedWrite(id);
			}),
			(error) => error.replicationUnconfirmed === true && error.retryable === false
		);
		assert.strictEqual((await First.get(id)).id, id);
	});

	for (const sourceFailure of [false, true]) {
		it(`rolls back when outcome metadata throws in ${sourceFailure ? 'pre-commit source work' : 'the callback'}`, async () => {
			const id = nextId();
			const failure = new Error('Application failure');
			Object.defineProperty(failure, 'replicationUnconfirmed', {
				get() {
					throw new Error('Outcome metadata is unreadable');
				},
			});
			const context = {};
			const links = [];
			function rememberLinks() {
				for (let link = context.transaction; link; link = link.next) {
					if (!links.includes(link)) links.push(link);
				}
			}
			class FailingSource extends First {}
			FailingSource.sourcedFrom({
				get() {},
				put() {
					rememberLinks();
					throw failure;
				},
			});
			try {
				await assert.rejects(
					transaction(context, async () => {
						await First.put({ id });
						rememberLinks();
						await (sourceFailure ? FailingSource : Second).put({ id: sourceFailure ? `source-${id}` : id });
						rememberLinks();
						if (!sourceFailure) throw failure;
					}),
					(error) => error === failure
				);
				for (const link of links) {
					assert.strictEqual(link.hasPendingWrites(), false);
					assert.ok(!link.transaction);
					assert.ok(!link.readTxn);
				}
				assert.equal(await First.get(id), null);
				assert.equal(await (sourceFailure ? First : Second).get(sourceFailure ? `source-${id}` : id), null);
			} finally {
				context.transaction?.abort();
			}
		});
	}

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

	for (const sourceFailure of [false, true]) {
		for (const abort of ['timeout', 'disconnect', 'explicit']) {
			it(`removes a nested flag after ${abort} discarded outer writes in ${sourceFailure ? 'source work' : 'the callback'}`, async () => {
				const id = nextId();
				const gate = Promise.withResolvers();
				const controller = new AbortController();
				const context = { signal: controller.signal };
				const failure = new ServerError('Nested peer timeout', 504);
				let entered = false;
				let scope;
				let settled = false;
				registerConfirmation(() => {
					entered = true;
					return gate.promise;
				});
				class OuterSource extends Second {}
				OuterSource.sourcedFrom({ get() {}, put: () => confirmedWrite(`inner-${id}`) });
				const completing = transaction(context, async (txn) => {
					scope = txn;
					await (sourceFailure ? OuterSource : Second).put({ id: `outer-${id}` });
					if (!sourceFailure) await confirmedWrite(`inner-${id}`);
				}).then(
					() => (settled = true),
					(error) => {
						settled = true;
						return error;
					}
				);
				try {
					await waitFor(() => entered);
					assert.strictEqual(scope.hasPendingWrites(), true);
					if (abort === 'timeout') scope.abortDueToTimeout();
					else if (abort === 'disconnect') controller.abort();
					else scope.abort();
					assert.strictEqual(scope.hasPendingWrites(), false);
					if (!sourceFailure) assert.strictEqual(scope.isChainCommitting(), false);
					gate.reject(failure);
					await waitFor(() => settled);
					const error = await completing;
					assert.strictEqual(error.replicationUnconfirmed, undefined);
					assert.strictEqual(error.cause.replicationUnconfirmed, true);
					assert.strictEqual(error.retryable, false);
					assert.strictEqual((await First.get(`inner-${id}`)).id, `inner-${id}`);
					assert.equal(await Second.get(`outer-${id}`), null);
				} finally {
					gate.resolve();
					await waitFor(() => settled);
					await completing;
				}
			});
		}
	}

	for (const explicit of [false, true]) {
		for (const poison of ['timeout', 'disconnect']) {
			it(`keeps an own committed outcome after ${poison}${explicit ? ' in an explicitly awaited commit' : ''}`, async () => {
				const id = nextId();
				const gate = Promise.withResolvers();
				const controller = new AbortController();
				const context = { replicatedConfirmation: 1, signal: controller.signal };
				let entered = false;
				let scope;
				let settled = false;
				registerConfirmation(() => {
					entered = true;
					return gate.promise;
				});
				const completing = transaction(context, async (txn) => {
					scope = txn;
					await First.put({ id });
					requestConfirmation(context);
					if (explicit) await txn.commit();
				}).then(
					() => (settled = true),
					(error) => {
						settled = true;
						return error;
					}
				);
				try {
					await waitFor(() => entered);
					if (poison === 'timeout') scope.abortDueToTimeout();
					else controller.abort();
					gate.reject(new ServerError('Own peer timeout', 504));
					await waitFor(() => settled);
					const error = await completing;
					assert.strictEqual(error.replicationUnconfirmed, true);
					assert.strictEqual(error.retryable, false);
					assert.strictEqual((await First.get(id)).id, id);
				} finally {
					gate.resolve();
					await waitFor(() => settled);
					await completing;
				}
			});
		}
	}

	it('keeps the committed outcome when its synchronous confirmation hook aborts the scope', async () => {
		const id = nextId();
		const context = { replicatedConfirmation: 1 };
		let scope;
		registerConfirmation(() => {
			scope.abort();
			throw new ServerError('Own peer timeout', 504);
		});
		await assert.rejects(
			transaction(context, async (txn) => {
				scope = txn;
				await First.put({ id });
				requestConfirmation(context);
			}),
			(error) => error.replicationUnconfirmed === true && error.retryable === false
		);
		assert.strictEqual((await First.get(id)).id, id);
	});

	it('does not certify outer writes after a swallowed local commit failure', async () => {
		const id = nextId();
		const context = {};
		registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
		await assert.rejects(
			transaction(context, async (scope) => {
				if (isLMDB) {
					await Second.getResource(`outer-${id}`, context, {});
					let link = scope;
					while (link.db?.path !== Second.primaryStore.path) link = link.next;
					link.addWrite({
						key: `failed-${id}`,
						store: Second.primaryStore,
						commit() {
							throw new Error('Application write failed inside the native batch');
						},
					});
				}
				await Second.put({ id: `outer-${id}` });
				if (!isLMDB) {
					let link = scope;
					while (link.db?.path !== Second.primaryStore.path) link = link.next;
					link.transaction.abort();
				}
				const previousRisk = Second.primaryStore.retryRisk;
				if (isLMDB) Second.primaryStore.retryRisk = 101;
				try {
					await assert.rejects(Promise.resolve().then(() => scope.commit()));
				} finally {
					Second.primaryStore.retryRisk = previousRisk;
				}
				assert.strictEqual(scope.hasPendingWrites(), false);
				await confirmedWrite(`inner-${id}`);
			}),
			(error) => error.replicationUnconfirmed === undefined && error.retryable === false
		);
		assert.equal(await Second.get(`outer-${id}`), null);
		assert.strictEqual((await First.get(`inner-${id}`)).id, `inner-${id}`);
	});

	it('keeps a later own outcome on a reused RocksDB self-committing context after a failed write', async function () {
		if (isLMDB) this.skip();
		const id = nextId();
		const context = {};
		await First.getResource(id, context, {});
		const scope = context.transaction;
		assert.strictEqual(scope.saveCommits, true);
		class Failing extends First {}
		Failing.sourcedFrom({
			get() {},
			put() {
				throw new ServerError('Source write failed', 502);
			},
		});
		const failing = await Failing.getResource(`failed-${id}`, context, {});
		await assert.rejects(
			Promise.resolve().then(() => failing.put({ id: `failed-${id}` }, { id: `failed-${id}` })),
			/Source write failed/
		);
		assert.strictEqual(context.transaction, scope);
		scope.replicatedConfirmation = 1;
		registerConfirmation(() => Promise.reject(new ServerError('Own peer timeout', 504)));
		const later = await First.getResource(`later-${id}`, context, {});
		await assert.rejects(
			Promise.resolve().then(() => later.put({ id: `later-${id}` }, { id: `later-${id}` })),
			(error) => error.replicationUnconfirmed === true && error.retryable === false
		);
		assert.equal(await First.get(`failed-${id}`), null);
		assert.strictEqual((await First.get(`later-${id}`)).id, `later-${id}`);
	});

	it('removes a nested outcome flag even when structured error details cannot be copied', async () => {
		const id = nextId();
		const failure = new ServerError('Nested peer timeout', 504);
		failure.http_resp_msg = {
			get detail() {
				throw new Error('Details are unreadable');
			},
		};
		registerConfirmation(() => Promise.reject(failure));
		await assert.rejects(
			transaction({}, async () => {
				await Second.put({ id: `outer-${id}` });
				await confirmedWrite(`inner-${id}`);
			}),
			(error) => {
				assert.strictEqual(error.replicationUnconfirmed, undefined);
				assert.strictEqual(error.cause.replicationUnconfirmed, true);
				assert.strictEqual(error.retryable, false);
				assert.strictEqual(error.http_resp_msg, undefined);
				return true;
			}
		);
		assert.strictEqual((await First.get(`inner-${id}`)).id, `inner-${id}`);
		assert.equal(await Second.get(`outer-${id}`), null);
	});

	for (const property of [
		'message',
		'statusCode',
		'code',
		'constructor',
		'http_resp_msg',
		'detail',
		'message-symbol',
		'message-object',
	]) {
		it(`removes a nested flag with ${property} diagnostics`, async () => {
			const id = nextId();
			registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
			let innerError;
			await assert.rejects(
				transaction({}, async () => {
					await Second.put({ id: `outer-${id}` });
					try {
						await confirmedWrite(`inner-${id}`);
					} catch (error) {
						innerError = error;
						if (property === 'constructor') error.code = undefined;
						if (property === 'message-symbol') error.message = Symbol('unreadable');
						else if (property === 'message-object')
							error.message = {
								toString() {
									throw new Error('Coercion failed');
								},
							};
						else
							Object.defineProperty(error, property, {
								get() {
									throw new Error('Diagnostic is unreadable');
								},
							});
						throw error;
					}
				}),
				(error) => {
					assert.strictEqual(error.replicationUnconfirmed, undefined);
					assert.strictEqual(error.retryable, false);
					assert.strictEqual(error.cause, innerError);
					return true;
				}
			);
			assert.strictEqual((await First.get(`inner-${id}`)).id, `inner-${id}`);
			assert.equal(await Second.get(`outer-${id}`), null);
		});
	}

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

	it('keeps an inner flag with unreadable diagnostics when there are no outer writes to abort', async () => {
		const id = nextId();
		registerConfirmation(() => Promise.reject(new ServerError('Nested peer timeout', 504)));
		let innerError;
		await assert.rejects(
			transaction({}, async () => {
				try {
					await confirmedWrite(id);
				} catch (error) {
					innerError = error;
					Object.defineProperty(error, 'message', {
						get() {
							throw new Error('Diagnostic is unreadable');
						},
					});
					throw error;
				}
			}),
			(error) => error === innerError && error.replicationUnconfirmed === true && error.retryable === false
		);
		assert.strictEqual((await First.get(id)).id, id);
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

	for (const property of ['replicationUnconfirmed', 'retryable']) {
		it(`retains a REST error response when ${property} cannot be read`, async () => {
			const failure = new ServerError('Diagnostic failure', 504);
			failure.code = 'DIAGNOSTIC_FAILURE';
			Object.defineProperty(failure, property, {
				get() {
					throw new Error('Outcome metadata is unreadable');
				},
			});
			class Diagnostic extends Resource {
				static loadAsInstance = false;
				async post() {
					throw failure;
				}
			}
			const resources = new Resources();
			resources.set('Diagnostic', Diagnostic);
			let listener;
			handleApplication({
				resources,
				options: { getAll: () => ({ webSocket: false }) },
				routeFor: () => ({ urlPath: `/diagnostic-outcome-${property}` }),
				server: { http: (handler) => (listener = handler) },
			});
			const response = await listener({
				method: 'POST',
				url: '/Diagnostic/error',
				pathname: '/Diagnostic/error',
				ip: '203.0.113.7',
				user: { username: 'admin', role: { permission: { super_user: true } } },
				headers: { asObject: {}, get: () => undefined },
			});
			assert.strictEqual(response.status, 504);
			assert.strictEqual(JSON.parse(response.body).title, 'Diagnostic failure');
			assert.strictEqual(JSON.parse(response.body).code, 'DIAGNOSTIC_FAILURE');
			assert.strictEqual(JSON.parse(response.body).replicationUnconfirmed, undefined);
		});
	}

	for (const rollback of [false, true, 'aborted']) {
		it(`publishes the REST outcome${rollback === 'aborted' ? ' after an earlier outer abort' : rollback ? ' after outer rollback' : ''} while retaining the original public code`, async () => {
			const id = nextId();
			registerConfirmation(() => Promise.reject(new ServerError('Peer timeout', 504)));
			class Signup extends Resource {
				static loadAsInstance = false;
				async post(target) {
					if (rollback) {
						await Second.put({ id: `outer-rest-${target.id}` });
						if (rollback === 'aborted') contextStorage.getStore().transaction.abort();
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
