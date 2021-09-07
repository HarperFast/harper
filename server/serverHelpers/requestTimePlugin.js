const fp = require('fastify-plugin');

module.exports = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('onResponse', async (request, reply) => {
			reply.getResponseTime();
		});
		// eslint-disable-next-line require-await
		fastify.addHook('onSend', async (request, reply) => {
			reply.header('HDB-Response-Time', reply.getResponseTime());
		});
		done();
	},
	{ name: 'hdb-request-time' }
);
