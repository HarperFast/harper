const { recordAction, recordActionBinary } = require('../../resources/analytics/write.ts');
const fp = require('fastify-plugin');

const ESTIMATED_HEADER_SIZE = 200; // it is very expensive to actually measure HTTP response header size (we change it
// ourselves) with an unacceptable performance penalty, so we estimate this part

module.exports = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('onResponse', async (request, reply) => {
			// elapsedTime has to be accessed in onResponse or it won't work
			let time = reply.elapsedTime;
		});
		// eslint-disable-next-line require-await
		fastify.addHook('onSend', async (request, reply, payload) => {
			let responseTime = reply.elapsedTime;
			let startTransfer = performance.now();
			let config = reply.request.routeOptions;
			let action;
			let type;
			let method;
			if (config.config?.isOperation) {
				action = request.body?.operation;
				type = 'operation';
			} else {
				action = config.url;
				type = 'fastify-route';
				method = config.method;
			}
			recordAction(responseTime, 'duration', action, method, type);
			// TODO: Remove the "success" metric, since we have switch to using recording responses by status code
			recordActionBinary(reply.raw.statusCode < 400, 'success', action, method, type);
			recordActionBinary(1, 'response_' + reply.raw.statusCode, action, method, type);
			let bytesSent = ESTIMATED_HEADER_SIZE;
			if (payload?.pipe) {
				// if we are sending a stream, track the bytes sent and wait for when it completes
				payload.on('data', (data) => {
					bytesSent += data.length;
				});
				payload.on('end', () => {
					recordAction(performance.now() - startTransfer, 'transfer', action, method, type);
					recordAction(bytesSent, 'bytes-sent', action, method, type);
				});
			} else {
				// otherwise just record bytes sent
				bytesSent += payload?.length || 0;
				recordAction(bytesSent, 'bytes-sent', action, method, type);
			}
			let roundedTime = responseTime.toFixed(3);
			let appServerTiming = reply.getHeader('Server-Timing');
			let serverTiming = `db;dur=${roundedTime}`;
			reply.header('Server-Timing', appServerTiming ? `${appServerTiming}, ${serverTiming}` : serverTiming);
		});
		done();
	},
	{ name: 'hdb-request-time' }
);
