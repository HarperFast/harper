'use strict';
const { streamAsJSON } = require('./JSONStream');
const { toCsvStream } = require('../../data_layer/export');
const { pack, unpack, encodeIter } = require('msgpackr');
const { decode, EncoderStream } = require('cbor-x');
const { Readable } = require('stream');
const media_types = {
	'application/json': {
		serialize: streamAsJSON,
		q: 0.8,
	},
	'application/cbor': {
		serialize: function(data) {
			return new EncoderStream(PUBLIC_ENCODE_OPTIONS).end(data);
		},
		q: 1,
	},
	'application/x-msgpack': {
		serialize: function(data) {
			if ((data?.[Symbol.iterator] || data?.[Symbol.asyncIterator]) && !Array.isArray(data)) {
				return Readable.from(encodeIter(data, PUBLIC_ENCODE_OPTIONS));
			}
			return pack(data);
		},
		q: 0.9,
	},
	'text/csv': {
		serialize: function (data) {
			this.header('Content-Disposition', 'attachment; filename="data.csv"');
			return toCsvStream(data);
		},
		q: 0.1,
	},
	'*/*': {
		type: 'application/json',
		serialize: streamAsJSON,
		q: 0.8,
	},
};

const PUBLIC_ENCODE_OPTIONS = {
	useRecords: false
};
function registerContentHandlers(app) {
	app.register(registerFastifySerializers, {
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

const fp = require('fastify-plugin');

let registerFastifySerializers = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('preSerialization', async (request, reply) => {
			let content_type = reply.raw.getHeader('content-type');
			if (content_type)
				return;
			let { serializer, type } = findBestSerializer(request.raw);
			reply.type(type);
			reply.serializer(serializer);
		});
		done();
	},
	{ name: 'content-type-negotiation' }
);

function findBestSerializer(incoming_message) {
	let accept_header = incoming_message.headers.accept;
	let best_serializer;
	let best_quality = 0;
	let best_type;
	let best_parameters;
	const accept_types = accept_header ? accept_header.toLowerCase().split(/\s*,\s*/) : [];
	for (const accept_type of accept_types) {
		const [ type, ...parameter_parts ] = accept_type.split(/\s*;\s*/);
		let client_quality = 1;
		const parameters = { q: 1 };
		for(const part of parameter_parts) {
			const equal_index = part.indexOf('=');
			parameters[part.substring(0, equal_index)] = part.substring(equal_index + 1);
		}
		client_quality = +parameters.q;
		const serializer = media_types[type];
		if (serializer) {
			const quality = (serializer.q || 1) * client_quality;
			if (quality > best_quality) {
				best_serializer = serializer.serialize;
				best_type = serializer.type || type;
				best_quality = quality;
				best_parameters = parameters;
			}
		}
	}
	if (!best_serializer) {
		if (accept_header) {
			return {
				serializer() {
					this.code(406).send('No supported content types found in Accept header, supported types include: ' + Object.keys(media_types).join(', '));
				}
			};
		} else { // default if Accept header is absent
			best_serializer = streamAsJSON;
			best_type = 'application/json';
		}
	}

	return { serializer: best_serializer, type: best_type, parameters: best_parameters };
}

module.exports = {
	registerContentHandlers,
	findBestSerializer
};
