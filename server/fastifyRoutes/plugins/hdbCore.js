'use strict';

const fp = require('fastify-plugin');

const {
	handlePostRequest,
	authHandler,
	reqBodyValidationHandler,
} = require('../../../server/serverHelpers/serverHandlers.js');

/**
 * Generates a fastify plugin containing three core methods
 *
 * @param server - a fastify server instance.
 */
async function hdbCore(server) {
	server.decorate('hdbCore', {
		preValidation: [reqBodyValidationHandler, authHandler],
		request: (request) => convertAsyncIterators(handlePostRequest(request, response)),
		requestWithoutAuthentication: (request, response) =>
			convertAsyncIterators(handlePostRequest(request, response, true)),
	});
}
// We convert responses that can only be asynchronously iterated to (promises of) arrays for
// backwards compatibility, we do not assume custom functions can handle these.
async function convertAsyncIterators(response) {
	response = await response;
	if (response?.[Symbol.asyncIterator] && !response[Symbol.iterator]) {
		// requires async iteration to access elements
		let array = [];
		for await (let element of response) {
			array.push(element);
		}
		return array;
	}
	return response;
}

module.exports = fp(hdbCore);
