'use strict';

const assert = require('assert');
const fastify = require('fastify');
const {
	hdbErrors,
	ReplicationConfirmationError,
	ServerError,
	HdbError,
	withoutReplicationUnconfirmed,
} = require('#src/utility/errors/hdbError');
const { serverErrorHandler, handlePostRequest } = require('#js/server/serverHelpers/serverHandlers');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { replicationConfirmation } = require('#src/resources/DatabaseTransaction');

describe('serverErrorHandler', function () {
	it('answers an ordinary 500 when a handler rejects with no error', async function () {
		const app = fastify();
		app.setErrorHandler(serverErrorHandler);
		app.get('/', async () => {
			throw undefined;
		});
		try {
			const response = await app.inject({ method: 'GET', url: '/' });
			assert.strictEqual(response.statusCode, 500, response.body);
			assert.deepStrictEqual(response.json(), { error: hdbErrors.DEFAULT_ERROR_MSGS[500] });
		} finally {
			await app.close();
		}
	});

	for (const structured of [false, true]) {
		it(`publishes a confirmation failure${structured ? ' with structured HdbError details' : ''}`, async () => {
			const app = fastify();
			app.setErrorHandler(serverErrorHandler);
			const cause = structured
				? new HdbError(new Error('Peer timeout'), { error: 'Peer timeout', peers: ['node-a'], retryable: true }, 504)
				: new ServerError('Peer timeout', 504);
			cause.retryable = true;
			cause.code = 'PEER_TIMEOUT';
			const failure = new ReplicationConfirmationError(cause);
			app.post('/', async () => {
				throw failure;
			});
			try {
				const response = await app.inject({ method: 'POST', url: '/' });
				assert.strictEqual(response.statusCode, 504);
				assert.strictEqual(response.json().replicationUnconfirmed, true);
				assert.strictEqual(response.json().code, 'PEER_TIMEOUT');
				assert.strictEqual(response.json().retryable, false);
				assert.strictEqual(response.json().error, 'Peer timeout');
				if (structured) assert.deepStrictEqual(response.json().peers, ['node-a']);
				assert.strictEqual(cause.replicationUnconfirmed, undefined);
			} finally {
				await app.close();
			}
		});
	}

	it('omits the flag from an ordinary local error', async () => {
		const app = fastify();
		app.setErrorHandler(serverErrorHandler);
		app.post('/', async () => {
			throw new ServerError('Local failure', 500);
		});
		try {
			const response = await app.inject({ method: 'POST', url: '/' });
			assert.deepStrictEqual(response.json(), { error: 'Local failure' });
		} finally {
			await app.close();
		}
	});

	for (const property of ['replicationUnconfirmed', 'retryable']) {
		it(`retains an operations error response when ${property} cannot be read`, async () => {
			const app = fastify();
			app.setErrorHandler(serverErrorHandler);
			const failure = new ServerError('Diagnostic failure', 504);
			failure.code = 'DIAGNOSTIC_FAILURE';
			failure.retryable = false;
			Object.defineProperty(failure, property, {
				get() {
					throw new Error('Outcome metadata is unreadable');
				},
			});
			app.post('/', async () => {
				throw failure;
			});
			try {
				const response = await app.inject({ method: 'POST', url: '/' });
				assert.strictEqual(response.statusCode, 504);
				assert.strictEqual(response.json().error, 'Diagnostic failure');
				assert.strictEqual(response.json().code, 'DIAGNOSTIC_FAILURE');
				assert.strictEqual(response.json().replicationUnconfirmed, undefined);
			} finally {
				await app.close();
			}
		});
	}

	for (const outcome of ['plain', 'committed', 'stripped']) {
		it(`preserves array error details${outcome === 'plain' ? ' without a flag' : ` in a ${outcome} envelope`}`, async () => {
			const app = fastify();
			app.setErrorHandler(serverErrorHandler);
			const details = ['Peer timeout'];
			const cause = new HdbError(new Error('Peer timeout'), details, 504);
			cause.code = 'PEER_TIMEOUT';
			app.post('/', async () => {
				const committed = new ReplicationConfirmationError(cause);
				throw outcome === 'plain'
					? cause
					: outcome === 'stripped'
						? withoutReplicationUnconfirmed(committed)
						: committed;
			});
			try {
				const response = await app.inject({ method: 'POST', url: '/' });
				assert.strictEqual(response.statusCode, 504);
				assert.deepStrictEqual(
					response.json(),
					outcome === 'plain'
						? details
						: {
								error: details,
								code: 'PEER_TIMEOUT',
								retryable: false,
								...(outcome === 'committed' ? { replicationUnconfirmed: true } : {}),
							}
				);
				assert.deepStrictEqual(cause.http_resp_msg, details);
			} finally {
				await app.close();
			}
		});
	}

	for (const property of ['message', 'code']) {
		it(`retains the operations outcome when structured fallback ${property} is unreadable`, async () => {
			const app = fastify();
			app.setErrorHandler(serverErrorHandler);
			const failure = new ReplicationConfirmationError(new ServerError('Peer timeout', 504));
			failure.code = 'PEER_TIMEOUT';
			failure.http_resp_msg = {
				get detail() {
					throw new Error('Details are unreadable');
				},
			};
			Object.defineProperty(failure, property, {
				get() {
					throw new Error('Diagnostic is unreadable');
				},
			});
			app.post('/', async () => {
				throw failure;
			});
			try {
				const response = await app.inject({ method: 'POST', url: '/' });
				assert.strictEqual(response.statusCode, 504, response.body);
				assert.strictEqual(response.json().replicationUnconfirmed, true);
				assert.strictEqual(response.json().retryable, false);
				assert.strictEqual(
					response.json().error,
					property === 'message' ? 'Replication confirmation failed' : 'Peer timeout'
				);
				assert.strictEqual(response.json().code, property === 'code' ? undefined : 'PEER_TIMEOUT');
			} finally {
				await app.close();
			}
		});
	}

	for (const unreadable of [false, true]) {
		it(`retains the flag through the real operations insert dispatch and a local commit${unreadable ? ' with unreadable structured details' : ''}`, async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			setupTestDBPath();
			setMainIsWorker(true);
			const Records = table({
				database: 'confirmation-outcome-operations',
				table: 'Records',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const id = unreadable ? 'committed-unreadable' : 'committed';
			const app = fastify();
			app.setErrorHandler(serverErrorHandler);
			app.addHook('preHandler', async (request) => {
				request.body.hdb_user = { username: 'admin', role: { permission: { super_user: true } } };
			});
			app.post('/', handlePostRequest);
			const failure = new ServerError('Peer timeout', 504);
			if (unreadable) {
				failure.http_resp_msg = {
					get detail() {
						throw new Error('Details are unreadable');
					},
				};
			}
			replicationConfirmation(() => Promise.reject(failure));
			try {
				const response = await app.inject({
					method: 'POST',
					url: '/',
					payload: {
						operation: 'insert',
						schema: 'confirmation-outcome-operations',
						table: 'Records',
						records: [{ id }],
						replicatedConfirmation: 1,
					},
				});
				assert.strictEqual(response.statusCode, 504, response.body);
				assert.strictEqual(response.json().replicationUnconfirmed, true);
				assert.strictEqual(response.json().retryable, false);
				assert.strictEqual(response.json().error, 'Peer timeout');
				assert.strictEqual((await Records.get(id)).id, id);
			} finally {
				replicationConfirmation(undefined);
				await app.close();
			}
		});
	}
});
