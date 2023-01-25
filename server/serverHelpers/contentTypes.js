const { streamAsJSON } = require('./JSONStream');
const { toCsvStream } = require('../../data_layer/export');
const fastify_serializer = require('@fastify/accepts-serializer');
const { pack, unpack, encodeIter } = require('msgpackr');
const { decode, EncoderStream } = require('cbor-x');
const { Readable } = require('stream');

module.exports = {
	registerContentHandlers
};
const PUBLIC_ENCODE_OPTIONS = {
	useRecords: false
};
function registerContentHandlers(app) {
	app.register(fastify_serializer, {
		serializers: [
			{
				regex: /^application\/json$/,
				serializer: streamAsJSON,
			},
			{
				regex: /^application\/cbor$/,
				serializer: function(data) {
					return new EncoderStream(PUBLIC_ENCODE_OPTIONS).end(data);
				},
			},
			{
				regex: /^application\/(x-)?msgpack$/,
				serializer: function(data) {
					if ((data?.[Symbol.iterator] || data?.[Symbol.asyncIterator]) && !Array.isArray(data)) {
						return Readable.from(encodeIter(data, PUBLIC_ENCODE_OPTIONS));
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
	});
	app.addContentTypeParser('application/x-msgpack', {parseAs: 'buffer'}, (req, body, done) => {
		try {
			done(null, unpack(body));
		} catch (error) {
			error.statusCode = 400;
			done(error);
		}
	});

	app.addContentTypeParser('application/cbor', {parseAs: 'buffer'}, (req, body, done) => {
		try {
			done(null, decode(body));
		} catch (error) {
			error.statusCode = 400;
			done(error);
		}
	});
}