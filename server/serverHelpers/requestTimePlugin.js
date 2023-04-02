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
			if (config.isOperation) {
				action = request.body?.operation;
			} else {
				action = config.url + '-' + config.method;
			}
			recordAction(action + '-TTFB', response_time);
			recordActionBinary(action + '-success', reply.raw.statusCode < 400);
			let bytes_sent = ESTIMATED_HEADER_SIZE;
			if (payload?.pipe) {
				// if we are sending a stream, track the bytes sent and wait for when it completes
				payload.on('data', (data) => {
					bytes_sent += data.length;
				});
				payload.on('end', () => {
					recordAction(action + '-transfer', performance.now() - start_transfer);
					recordAction(action + '-bytes-sent', bytes_sent);
				});
			} else {
				// otherwise just record bytes sent
				bytes_sent += payload?.length || 0;
				recordAction(action + '-bytes-sent', bytes_sent);
			}
			let rounded_time = response_time.toFixed(3);
			reply.header('HDB-Response-Time', rounded_time);
			reply.header('Server-Timing', `db;dur=${rounded_time}`);
		});
		done();
	},
	{ name: 'hdb-request-time' }
);
