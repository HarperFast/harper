'use strict';

const assert = require('assert');
const fastify = require('fastify');
const { hdbErrors, ReplicationConfirmationError, ServerError, HdbError } = require('#src/utility/errors/hdbError');
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
			const failure = new ReplicationConfirmationError(cause);
			app.post('/', async () => {
				throw failure;
			});
			try {
				const response = await app.inject({ method: 'POST', url: '/' });
				assert.strictEqual(response.statusCode, 504);
				assert.strictEqual(response.json().replicationUnconfirmed, true);
				assert.notEqual(response.json().retryable, true);
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

	it('retains the flag through the real operations insert dispatch and a local commit', async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const Records = table({
			database: 'confirmation-outcome-operations',
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const app = fastify();
		app.setErrorHandler(serverErrorHandler);
		app.addHook('preHandler', async (request) => {
			request.body.hdb_user = { username: 'admin', role: { permission: { super_user: true } } };
		});
		app.post('/', handlePostRequest);
		replicationConfirmation(() => Promise.reject(new ServerError('Peer timeout', 504)));
		try {
			const response = await app.inject({
				method: 'POST',
				url: '/',
				payload: {
					operation: 'insert',
					schema: 'confirmation-outcome-operations',
					table: 'Records',
					records: [{ id: 'committed' }],
					replicatedConfirmation: 1,
				},
			});
			assert.strictEqual(response.statusCode, 504, response.body);
			assert.strictEqual(response.json().replicationUnconfirmed, true);
			assert.strictEqual((await Records.get('committed')).id, 'committed');
		} finally {
			replicationConfirmation(undefined);
			await app.close();
		}
	});
});
