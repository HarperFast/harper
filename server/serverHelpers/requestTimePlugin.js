const fp = require('fastify-plugin');

module.exports = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('onResponse', async (request, reply) => {
			reply.getResponseTime();
		});
		// eslint-disable-next-line require-await
		fastify.addHook('onSend', async (request, reply) => {
			let responseTime = reply.getResponseTime().toFixed(3);
			reply.header('HDB-Response-Time', responseTime);
			reply.header('Server-Timing', `db;dur=${responseTime}`);
		});
		done();
	},
	{ name: 'hdb-request-time' }
);
