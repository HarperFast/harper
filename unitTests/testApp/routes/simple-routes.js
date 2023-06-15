'use strict';

// eslint-disable-next-line no-unused-vars,require-await
export default async (server, { hdbCore, logger }) => {
	// GET, WITH NO preValidation AND USING hdbCore.requestWithoutAuthentication
	// BYPASSES ALL CHECKS: DO NOT USE RAW USER-SUBMITTED VALUES IN SQL STATEMENTS
	const checkAuth = (req, resp, done) => {
		req.body = {};
		try {
			// try a request
			hdbCore.preValidation[1](req, resp, (error) => {
				if (error)
					// return a redirect to the login upon error
					return resp.code(302).header('Location', 'login.html').send('no dogs for you!');
				// callback if successful
				done();
			});
		} catch (error) {
			console.error(error);
			resp.code(302).header('Location', 'login.html');
		}
	};
	server.route({
		url: '/',
		method: 'GET',
		preValidation: checkAuth,
		handler: (request, reply) => {
			reply.send('hello');
		},
	});

	// POST, WITH STANDARD PASS-THROUGH BODY, PAYLOAD AND HDB AUTHENTICATION
	server.route({
		url: '/',
		method: 'POST',
		preValidation: hdbCore.preValidation,
		handler: hdbCore.request,
	});

	// GET, WITH ASYNC THIRD-PARTY AUTH PREVALIDATION
	server.route({
		url: '/:id',
		method: 'GET',
		preValidation: checkAuth,
		handler: (request, reply) => {
			reply.send({ hello: request.params.id });
		},
	});
};
