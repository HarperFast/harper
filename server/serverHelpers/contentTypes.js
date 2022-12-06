const { streamAsJSON } = require('./JSONStream');
const { toCsvStream } = require('../../data_layer/export');
const fastify_serializer = require('@fastify/accepts-serializer');
const { pack, unpack, encodeIter } = require('msgpackr');
const { Readable } = require('stream');

module.exports = {
	registerContentHandlers
}
function registerContentHandlers(app) {
	app.register(fastify_serializer, {
		serializers: [
			{
				regex: /^application\/json$/,
				serializer: streamAsJSON,
			},
			{
				regex: /^application\/(x-)?msgpack$/,
				serializer: function(data) {
					if (data?.[Symbol.iterator] && !Array.isArray(data)) {
						return Readable.from(encodeIter(data));
					}
					return pack(data);
				},
			},
			{
				regex: /^text\/csv$/,
				serializer: function (data) {
					this.header('Content-Disposition', 'attachment; filename="data.csv"');
					return toCsvStream(data);
				},
			},
		],
		default: 'application/json',
	});
	app.addContentTypeParser('application/x-msgpack', {parseAs: 'buffer'}, (req, body, done) => {
		try {
			done(null, unpack(body));
		} catch (error) {
			error.statusCode = 400;
			done(error);
		}
	});
}