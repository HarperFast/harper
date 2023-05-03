import { streamAsJSON } from './JSONStream';
import { toCsvStream } from '../../dataLayer/export';
import { pack, unpack, encodeIter } from 'msgpackr';
import { decode, encode, EncoderStream } from 'cbor-x';
import { createBrotliCompress, brotliCompress, constants } from 'zlib';
import { Readable } from 'stream';
import { server, ContentTypeHandler } from '../Server';

server.contentType = function (mime_type: string, handler: ContentTypeHandler) {
	media_types.set(mime_type, handler);
};

const media_types = new Map();
// TODO: Make these monomorphic for faster access. And use a Map
media_types.set('application/json', {
	serializeStream: streamAsJSON,
	serialize: JSON.stringify,
	deserialize: JSON.parse,
	q: 0.8,
});
media_types.set('application/cbor', {
	serializeStream(data) {
		return new EncoderStream(PUBLIC_ENCODE_OPTIONS).end(data);
	},
	serialize: encode,
	deserialize: decode,
	q: 1,
});
media_types.set('application/x-msgpack', {
	serializeStream(data) {
		if ((data?.[Symbol.iterator] || data?.[Symbol.asyncIterator]) && !Array.isArray(data)) {
			return Readable.from(encodeIter(data, PUBLIC_ENCODE_OPTIONS));
		}
		return pack(data);
	},
	serialize: pack,
	deserialize: unpack,
	q: 0.9,
});
media_types.set('text/csv', {
	serializeStream(data) {
		this.header('Content-Disposition', 'attachment; filename="data.csv"');
		return toCsvStream(data);
	},
	q: 0.1,
});
media_types.set('text/plain', {
	serialize(data) {
		return data.toString();
	},
	deserialize(data) {
		return data.toString();
	},
	q: 0.01,
});
media_types.set('text/event-stream', {
	// Server-Sent Events (SSE)
	serializeStream: function (iterable) {
		// create a readable stream that we use to stream out events from our subscription
		const serialize = this.serialize;
		return Readable.from(
			(async function* () {
				for await (const message of iterable) {
					// TODO: if we can skip messages, use back-pressure and allow messages to be skipped
					yield serialize(message);
				}
			})()
		);
	},
	serialize: function (message) {
		if (message.data || message.event) {
			let serialized = '';
			if (message.event) serialized += 'event: ' + message.event + '\n';
			if (message.data) {
				let data = message.data;
				if (typeof data === 'object') data = JSON.stringify(data);
				serialized += 'data: ' + data + '\n';
			}
			if (message.id) serialized += 'id: ' + message.id + '\n';
			if (message.retry) serialized += 'retry: ' + message.retry + '\n';
			return serialized + '\n';
		} else {
			return 'data: ' + message + '\n\n';
		}
	},
	q: 0.8,
});
// TODO: Support this as well:
//'multipart/form-data'
media_types.set('application/x-www-form-urlencoded', {
	deserialize(data) {
		const object = {};
		for (const [key, value] of new URLSearchParams(data)) {
			if (object.hasOwnProperty(key)) {
				// in case there are multiple query params with the same name, convert them to an array
				const last = object[key];
				if (Array.isArray(last)) last.push(value);
				else object.key = [last, value];
			} else object[key] = value;
		}
	},
	serialize(data) {
		const usp = new URLSearchParams();
		for (const key in data) {
			usp.set(key, data);
		}
		return usp.toString();
	},
});
media_types.set('*/*', {
	type: 'application/json',
	serializeStream: streamAsJSON,
	serialize: JSON.stringify,
	deserialize: JSON.parse,
	q: 0.8,
});

const PUBLIC_ENCODE_OPTIONS = {
	useRecords: false,
};
export function registerContentHandlers(app) {
	app.register(registerFastifySerializers, {
		serializers: [
			{
				regex: /^application\/json$/,
				serializer: streamAsJSON,
			},
			{
				regex: /^application\/cbor$/,
				serializer: function (data) {
					return new EncoderStream(PUBLIC_ENCODE_OPTIONS).end(data);
				},
			},
			{
				regex: /^application\/(x-)?msgpack$/,
				serializer: function (data) {
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
	app.addContentTypeParser('application/x-msgpack', { parseAs: 'buffer' }, (req, body, done) => {
		try {
			done(null, unpack(body));
		} catch (error) {
			error.statusCode = 400;
			done(error);
		}
	});

	app.addContentTypeParser('application/cbor', { parseAs: 'buffer' }, (req, body, done) => {
		try {
			done(null, decode(body));
		} catch (error) {
			error.statusCode = 400;
			done(error);
		}
	});
}
// TODO: Only load this if fastify is loaded
const fp = require('fastify-plugin');

const registerFastifySerializers = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('preSerialization', async (request, reply) => {
			const content_type = reply.raw.getHeader('content-type');
			if (content_type) return;
			const { serializer, type } = findBestSerializer(request.raw);
			reply.type(type);
			reply.serializer(serializer.serializeStream || serializer.serialize);
		});
		done();
	},
	{ name: 'content-type-negotiation' }
);

/**
 * This is returns the best serializer for the request's Accept header (content negotiation)
 * @param incoming_message
 * @returns {{serializer, type: string, parameters: {q: number}}|{serializer(): void}}
 */
export function findBestSerializer(incoming_message) {
	const accept_header = incoming_message.headers.accept;
	let best_serializer;
	let best_quality = 0;
	let best_type;
	let best_parameters;
	const accept_types = accept_header ? accept_header.toLowerCase().split(/\s*,\s*/) : [];
	for (const accept_type of accept_types) {
		const [type, ...parameter_parts] = accept_type.split(/\s*;\s*/);
		let client_quality = 1;
		const parameters = { q: 1 };
		for (const part of parameter_parts) {
			const equal_index = part.indexOf('=');
			parameters[part.substring(0, equal_index)] = part.substring(equal_index + 1);
		}
		client_quality = +parameters.q;
		const serializer = media_types.get(type);
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
					this.code(406).send(
						'No supported content types found in Accept header, supported types include: ' +
							Object.keys(media_types).join(', ')
					);
				},
			};
		} else {
			// default if Accept header is absent
			best_serializer = media_types.get('application/json');
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
export function serialize(response_data, request, response_object) {
	// TODO: Maybe support other compression encodings; browsers basically universally support brotli, but Node's HTTP
	//  client itself actually (just) supports gzip/deflate
	const compress = request.headers['accept-encoding']?.includes('br');
	let response_body;
	if (response_data?.contentType != null && response_data.data != null) {
		// we use this as a special marker for blobs of data that are explicitly one content type
		response_object.headers['Content-Type'] = response_data.contentType;
		response_object.headers['Vary'] = 'Accept-Encoding';
		response_body = response_data.data;
	}
	if (response_data instanceof Uint8Array) {
		// If a user function or property returns a direct Buffer of binary data, this is the most appropriate content
		// type for it.
		response_object.headers['Content-Type'] = 'application/octet-stream';
		response_object.headers['Vary'] = 'Accept-Encoding';
		response_body = response_data;
	} else {
		const serializer = findBestSerializer(request);
		// TODO: If a different content type is preferred, look through resources to see if there is one
		// specifically for that content type (most useful for html).
		response_object.headers['Vary'] = 'Accept, Accept-Encoding';
		response_object.headers['Content-Type'] = serializer.type;
		if (serializer.serializer.serializeStream) {
			let stream = serializer.serializer.serializeStream(response_data);
			if (compress) {
				response_object.headers['Content-Encoding'] = 'br';
				// TODO: Use the fastest setting here and only do it if load is low
				stream = stream.pipe(
					createBrotliCompress({
						//flush: constants.BROTLI_OPERATION_FLUSH,
					})
				);
			}
			return stream;
		}
		response_body = serializer.serializer.serialize(response_data);
	}
	if (compress) {
		// TODO: Only do this if the size is large and we can cache the result (otherwise use logic above)
		response_object.headers['Content-Encoding'] = 'br';
		// if we have a single buffer (or string) we compress in a single async call
		response_body = new Promise((resolve) => brotliCompress(response_body, resolve));
	}
	return response_body;
}

/**
 * Serialize a message, may be use multiple times (like with WebSockets)
 * @param message
 * @param request
 * @returns {*}
 */
export function serializeMessage(message, request) {
	if (message?.contentType != null && message.data != null) return message;
	let serialize = request.serialize;
	if (serialize) return serialize(message);
	const serializer = findBestSerializer(request);
	serialize = request.serialize = serializer.serializer.serialize;
	return serialize(message);
}

export function getDeserializer(content_type, body) {
	if (!content_type) {
		if (body?.[0] === 123) {
			// left curly brace
			return tryJSONParse;
		}
		return (data) => ({ contentType: '', data });
	}
	const parameters_start = content_type.indexOf(';');
	let parameters;
	if (parameters_start > -1) {
		parameters = content_type.slice(parameters_start + 1);
		content_type = content_type.slice(0, parameters_start);
	}
	return media_types.get(content_type)?.deserialize || deserializeUnknownType(content_type, parameters);
}
function deserializeUnknownType(content_type, parameters) {
	// TODO: store the content-disposition too
	if (content_type.startsWith('text/')) {
		// convert the data to a string since it is text (using the provided charset if specified)
		const charset = parameters?.match(/charset=(.+)/)?.[1] || 'utf-8';
		return (data) => ({
			contentType: content_type,
			data: data.toString(charset),
		});
	} else if (content_type === 'application/octet-stream') {
		// use this type as a way of directly transferring binary data (since that is what it means)
		return (data) => data;
	} else {
		// else record the type and binary data as a pair
		return (data) => ({ contentType: content_type, data });
	}
}
// try to JSON parse, but since we don't know for sure, this will return the body
// otherwise
function tryJSONParse(input) {
	try {
		return JSON.parse(input);
	} catch (error) {
		return input;
	}
}
