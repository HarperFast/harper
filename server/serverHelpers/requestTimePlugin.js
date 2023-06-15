const { recordAction, recordActionBinary } = require('../../resources/analytics');
const fp = require('fastify-plugin');

const ESTIMATED_HEADER_SIZE = 200; // it is very expensive to actually measure HTTP response header size (we change it
// ourselves) with an unacceptable performance penalty, so we estimate this part

module.exports = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('onResponse', async (request, reply) => {
			reply.getResponseTime();
		});
		// eslint-disable-next-line require-await
		fastify.addHook('onSend', async (request, reply, payload) => {
			let response_time = reply.getResponseTime();
			let start_transfer = performance.now();
			let config = reply.context.config;
			let action;
			let type;
			let method;
			if (config.isOperation) {
				action = request.body?.operation;
				type = 'operation';
			} else {
				action = config.url;
				type = 'fastify-route';
				method = config.method;
			}
			recordAction(response_time, 'TTFB', action, method, type);
			recordActionBinary(reply.raw.statusCode < 400, 'success', action, method, type);
			let bytes_sent = ESTIMATED_HEADER_SIZE;
			if (payload?.pipe) {
				// if we are sending a stream, track the bytes sent and wait for when it completes
				payload.on('data', (data) => {
					bytes_sent += data.length;
				});
				payload.on('end', () => {
					recordAction(performance.now() - start_transfer, 'transfer', action, method, type);
					recordAction(bytes_sent, 'bytes-sent', action, method, type);
				});
			} else {
				// otherwise just record bytes sent
				bytes_sent += payload?.length || 0;
				recordAction(bytes_sent, 'bytes-sent', action, method, type);
			}
			let rounded_time = response_time.toFixed(3);
			reply.header('HDB-Response-Time', rounded_time);
			reply.header('Server-Timing', `db;dur=${rounded_time}`);
		});
		done();
	},
	{ name: 'hdb-request-time' }
);
