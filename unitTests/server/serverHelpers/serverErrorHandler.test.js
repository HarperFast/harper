'use strict';

const assert = require('assert');
const fastify = require('fastify');
const { hdbErrors } = require('#src/utility/errors/hdbError');
const { serverErrorHandler } = require('#js/server/serverHelpers/serverHandlers');

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
});
