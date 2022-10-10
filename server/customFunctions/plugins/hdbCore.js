'use strict';

const fp = require('fastify-plugin');

const {
	handlePostRequest,
	authHandler,
	reqBodyValidationHandler,
} = require('../../../server/serverHelpers/serverHandlers');

/**
 * Generates a fastify plugin containing three core methods
 *
 * @param server - a fastify server instance.
 */
async function hdbCore(server) {
	server.decorate('hdbCore', {
		preValidation: [reqBodyValidationHandler, authHandler],
		request: handlePostRequest,
		requestWithoutAuthentication: (request, response) => handlePostRequest(request, response, true),
	});
}

module.exports = fp(hdbCore);
