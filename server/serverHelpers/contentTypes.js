'use strict';
const { streamAsJSON } = require('./JSONStream');
const { toCsvStream } = require('../../dataLayer/export');
const { pack, unpack, encodeIter } = require('msgpackr');
const { decode, encode, EncoderStream } = require('cbor-x');
const { Readable } = require('stream');
const media_types = { // TODO: Make these monomorphic for faster access. And use a Map
	'application/json': {
		serializeStream: streamAsJSON,
		serialize: JSON.stringify,
		deserialize: JSON.parse,
		q: 0.8,
	},
	'application/cbor': {
		serializeStream: function(data) {
			return new EncoderStream(PUBLIC_ENCODE_OPTIONS).end(data);
		},
		serialize: encode,
		deserialize: decode,
		q: 1,
	},
	'application/x-msgpack': {
		serializeStream: function(data) {
			if ((data?.[Symbol.iterator] || data?.[Symbol.asyncIterator]) && !Array.isArray(data)) {
				return Readable.from(encodeIter(data, PUBLIC_ENCODE_OPTIONS));
			}
			return pack(data);
		},
		serialize: pack,
		deserialize: unpack,
		q: 0.9,
	},
	'text/csv': {
		serializeStream: function (data) {
			this.header('Content-Disposition', 'attachment; filename="data.csv"');
			return toCsvStream(data);
		},
		q: 0.1,
	},
	'text/event-stream': { // Server-Sent Events (SSE)
		serializeStream: function(subscription) {
			// create a readable stream that we use to stream out events from our subscription
			let stream = new Readable({
			});
			// TODO: if we can skip messages, use back-pressure and allow messages to be skipped
			subscription.callback = (data) => {
				stream.push(data);
			};
			stream.on('end', () => subscription.end());
			return stream;
		},
		q: 0.8
	},
	// TODO: Support this as well:
	//'multipart/form-data'
	'application/x-www-form-urlencoded': {
		deserialize(data) {
			let object = {};
			for (let [ key, value ] of new URLSearchParams(data)) {
				if (object.hasOwnProperty(key)) {
					// in case there are multiple query params with the same name, convert them to an array
					let last = object[key];
					if (Array.isArray(last)) last.push(value);
					else object.key = [last, value];
				} else object[key] = value;
			}
		},
		serialize(data) {
			let usp = new URLSearchParams();
			for (let key in data) {
				usp.set(key, data);
			}
			return usp.toString();
		}
	},
	'*/*': {
		type: 'application/json',
		serializeStream: streamAsJSON,
		serialize: JSON.stringify,
		deserialize: JSON.parse,
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
			reply.serializer(serializer.serializeStream || serializer.serialize);
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
				best_serializer = serializer;
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
			best_serializer = media_types['application/json'];
			best_type = 'application/json';
		}
	}

	return { serializer: best_serializer, type: best_type, parameters: best_parameters };
}

/**
 * Serialize a response
 * @param response_data
 * @param request
 * @param response_object
 * @returns {Uint8Array|*}
 */
function serialize(response_data, request, response_object) {
	if (response_data?.contentType && response_data.data) {
		response_object.headers['Content-Type'] = response_data.contentType;
		return response_data.data;
	}
	if (response_data instanceof Uint8Array) {
		response_object.headers['Content-Type'] = 'application/octet-stream';
		return response_data;
	}
	let serializer = findBestSerializer(request);
	// TODO: If a different content type is preferred, look through resources to see if there is one
	// specifically for that content type (most useful for html).

	response_object.headers['Content-Type'] = serializer.type;
	if (serializer.serializer.serializeStream)
		return serializer.serializer.serializeStream(response_data);
	return serializer.serializer.serialize(response_data);
}

/**
 * Serialize a message, may be use multiple times (like with WebSockets)
 * @param message
 * @param request
 * @returns {*}
 */
function serializeMessage(message, request) {
	let serialize = request.serialize;
	if (serialize) return serialize(message);
	let serializer = findBestSerializer(request);
	serialize = request.serialize = serializer.serializer.serialize;
	return serialize(message);
}

function getDeserializer(content_type) {
	if (!content_type) return media_types['application/json'].deserialize;
	let parameters_start = content_type.indexOf(';');
	let parameters;
	if (parameters_start > -1) {
		parameters = content_type.slice(parameters_start + 1);
		content_type = content_type.slice(0, parameters_start);
	}
	return media_types[content_type]?.deserialize || deserializeUnknownType(content_type, parameters);
}
function deserializeUnknownType(content_type, parameters) {
	// TODO: store the content-disposition too
	if (content_type.startsWith('text/')) {
		// convert the data to a string since it is text (using the provided charset if specified)
		let charset = parameters?.match(/charset=(.+)/)?.[1] || 'utf-8';
		return (data) => ({
			contentType: content_type,
			data: data.toString(charset),
		});
	} else if (content_type === 'application/octet-stream') {
		// use this type as a way of directly transferring binary data (since that is what it means)
		return data => data;
	} else { // else record the type and binary data as a pair
		return (data) => ({ type, data });
	}
}

module.exports = {
	registerContentHandlers,
	serializeMessage,
	getDeserializer,
	serialize,
};
