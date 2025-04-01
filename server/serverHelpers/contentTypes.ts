import { streamAsJSON, stringify, parse } from './JSONStream';
import { pack, unpack, encodeIter } from 'msgpackr';
import { decode, Encoder, EncoderStream } from 'cbor-x';
import { createBrotliCompress, brotliCompress, constants } from 'zlib';
import { ClientError } from '../../utility/errors/hdbError';
import stream, { Readable } from 'stream';
import { server } from '../Server';
import { _assignPackageExport } from '../../globals';
import env_mgr from '../../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../../utility/hdbTerms';
import * as YAML from 'yaml';
import logger from '../../utility/logging/logger';
import { Blob } from '../../resources/blob';
import { Transform } from 'json2csv';
// TODO: Only load this if fastify is loaded
import fp from 'fastify-plugin';
const SERIALIZATION_BIGINT = env_mgr.get(CONFIG_PARAMS.SERIALIZATION_BIGINT) !== false;
const JSONStringify = SERIALIZATION_BIGINT ? stringify : JSON.stringify;
const JSONParse = SERIALIZATION_BIGINT ? parse : JSON.parse;

const PUBLIC_ENCODE_OPTIONS = {
	useRecords: false,
	useToJSON: true,
};

type Deserialize = (data: Buffer) => { contentType?: string; data: unknown } | unknown;

const media_types = new Map<
	string,
	{
		serialize?: unknown;
		deserialize?: Deserialize;
		serializeStream?: unknown;
		compressible?: boolean;
		q?: number;
	}
>();

export const contentTypes = media_types;
server.contentTypes = contentTypes;
_assignPackageExport('contentTypes', contentTypes);
// TODO: Make these monomorphic for faster access. And use a Map
media_types.set('application/json', {
	serializeStream: streamAsJSON,
	serialize: JSONStringify,
	deserialize(data) {
		return JSONParse(data);
	},
	q: 0.8,
});
const cbor_encoder = new Encoder(PUBLIC_ENCODE_OPTIONS);
media_types.set('application/cbor', {
	serializeStream(data) {
		if (data[Symbol.asyncIterator]) data[Symbol.iterator] = null; // choose async iteration if possible
		return new EncoderStream(PUBLIC_ENCODE_OPTIONS).end(data);
	},
	serialize: cbor_encoder.encode,
	deserialize: cbor_encoder.decode,
	q: 1,
});
media_types.set('application/x-msgpack', {
	serializeStream(data: any) {
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
	serializeStream(data: any, response: Response) {
		response.headers.set('Content-Disposition', 'attachment; filename="data.csv"');
		return toCsvStream(data, data?.getColumns?.());
	},
	serialize(data: any, response: Response) {
		response.headers.set('Content-Disposition', 'attachment; filename="data.csv"');
		if (data && !data[Symbol.iterator]) data = [data.toJSON ? data.toJSON() : data];
		return toCsvStream(data, data?.getColumns?.());
	},
	q: 0.1,
});
media_types.set('text/plain', {
	serialize(data: any) {
		return data.toString();
	},
	serializeStream(data: any) {
		return Readable.from(data.map ? data.map((d) => d.toString()) : data);
	},
	deserialize(data: Buffer) {
		return data.toString();
	},
	q: 0.2,
});

media_types.set('text/yaml', {
	serialize(data) {
		return YAML.stringify(data, { aliasDuplicateObjects: false });
	},

	q: 0.7,
});

media_types.set('text/event-stream', {
	// Server-Sent Events (SSE)
	serializeStream: function (iterable) {
		// create a readable stream that we use to stream out events from our subscription
		return Readable.from(transformIterable(iterable, this.serialize));
	},
	serialize: function (message) {
		if (message.acknowledge) message.acknowledge();
		if (typeof message === 'object' && 'value' in message && message.timestamp) {
			// native messages
			message = {
				data: message.value,
				event: message.type,
				id: message.timestamp,
			};
		}
		if (message.data || message.event) {
			let serialized = '';
			if (message.event) serialized += 'event: ' + message.event + '\n';
			if (message.data) {
				let data = message.data;
				if (typeof data === 'object') data = JSONStringify(data);
				serialized += 'data: ' + data + '\n';
			}
			if (message.id) serialized += 'id: ' + message.id + '\n';
			if (message.retry) serialized += 'retry: ' + message.retry + '\n';
			return serialized + '\n';
		} else {
			if (typeof message === 'object') return `data: ${JSONStringify(message)}\n\n`;
			return `data: ${message}\n\n`;
		}
	},
	compressible: false,
	q: 0.8,
});
// TODO: Support this as well:
//'multipart/form-data'
media_types.set('application/x-www-form-urlencoded', {
	deserialize(data) {
		const stringData = Buffer.isBuffer(data) ? data.toString('utf8') : data;
		const object: Record<string, string | string[]> = {};
		for (const [key, value] of new URLSearchParams(stringData)) {
			if (object.hasOwnProperty(key)) {
				// in case there are multiple query params with the same name, convert them to an array
				const last = object[key];
				if (Array.isArray(last)) last.push(value);
				else object.key = [last, value];
			} else object[key] = value;
		}
		return object;
	},
	serialize(data) {
		const usp = new URLSearchParams();
		for (const key in data) {
			usp.set(key, data);
		}
		return usp.toString();
	},
});
const generic_handler = {
	type: 'application/json',
	serializeStream: streamAsJSON,
	serialize: JSONStringify,
	deserialize: tryJSONParse,
	q: 0.5,
};
media_types.set('*/*', generic_handler);
media_types.set('', generic_handler);
// try to JSON parse, but since we don't know for sure, this will return the body
// otherwise
function tryJSONParse(input) {
	try {
		if (input?.[0] === 123) return JSONParse(input);
		else return input;
	} catch (error) {
		return input;
	}
}
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

const registerFastifySerializers = fp(
	function (fastify, opts, done) {
		// eslint-disable-next-line require-await
		fastify.addHook('preSerialization', async (request, reply) => {
			const content_type = reply.raw.getHeader('content-type');
			if (content_type) return;
			const { serializer, type } = findBestSerializer(request.raw);
			reply.type(type);
			reply.serializer(function (data: any) {
				let serialize: (data: any, context: any) => any;
				if (
					typeof data === 'object' &&
					data &&
					(data[Symbol.iterator] || data[Symbol.asyncIterator]) &&
					serializer.serializeStream
				) {
					if (data.mapError) {
						// indicate that we want iterator errors to be returned so we can serialize them in a meaningful way, if possible
						const getColumns = data.getColumns;
						data = data.mapError((error) => {
							// make errors serializable in a descriptive way
							error.toJSON = () => ({ error: error.name, message: error.message, ...error.partialObject });
							return error;
						});
						data.getColumns = getColumns;
					}
					serialize = serializer.serializeStream;
				} else serialize = serializer.serialize;

				return serialize(data, {
					// a small header shim to allow us to set headers in serializers
					headers: {
						set: (key, value) => {
							reply.header(key, value);
						},
					},
				});
			});
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
	const headers_object = incoming_message.headers.asObject || incoming_message.headers;
	const accept_type = incoming_message.requestedContentType ?? headers_object.accept;
	let best_serializer;
	let best_quality = 0;
	let best_type;
	let best_parameters;
	const accept_types = accept_type ? accept_type.toLowerCase().split(/\s*,\s*/) : [];
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
		if (accept_type) {
			throw new ClientError(
				'No supported content types found in Accept header, supported types include: ' +
					Array.from(media_types.keys()).join(', '),
				406
			);
		} else {
			// default if Accept header is absent
			best_serializer = media_types.get('application/json');
			best_type = 'application/json';
		}
	}

	return { serializer: best_serializer, type: best_type, parameters: best_parameters };
}

// about an average TCP packet size (if headers included)
const COMPRESSION_THRESHOLD = env_mgr.get(CONFIG_PARAMS.HTTP_COMPRESSIONTHRESHOLD);
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
	let can_compress = COMPRESSION_THRESHOLD && request.headers.asObject?.['accept-encoding']?.includes('br');
	let response_body;
	if (response_data?.contentType != null && response_data.data != null) {
		// we use this as a special marker for blobs of data that are explicitly one content type
		response_object.headers.set('Content-Type', response_data.contentType);
		response_object.headers.set('Vary', 'Accept-Encoding');
		response_body = response_data.data;
	} else if (response_data instanceof Uint8Array || response_data instanceof Blob) {
		// If a user function or property returns a direct Buffer of binary data, this is the most appropriate content
		// type for it.
		response_object.headers.set('Content-Type', 'application/octet-stream');
		response_object.headers.set('Vary', 'Accept-Encoding');
		response_body = response_data;
	} else {
		const serializer = findBestSerializer(request);
		if (serializer.serializer.compressible === false) can_compress = false;
		// TODO: If a different content type is preferred, look through resources to see if there is one
		// specifically for that content type (most useful for html).
		response_object.headers.set('Vary', 'Accept, Accept-Encoding');
		response_object.headers.set('Content-Type', serializer.type);
		if (
			typeof response_data === 'object' &&
			response_data &&
			(response_data[Symbol.iterator] || response_data[Symbol.asyncIterator]) &&
			serializer.serializer.serializeStream
		) {
			if (response_data.mapError) {
				// indicate that we want iterator errors to be returned so we can serialize them in a meaningful way, if possible
				const getColumns = response_data.getColumns;
				response_data = response_data.mapError((error) => {
					// make errors serializable in a descriptive way
					error.toJSON = () => ({ error: error.name, message: error.message, ...error.partialObject });
					logger.warn?.(`Error serializing error ${request?.url || request}: ${error}`);
					return error;
				});
				response_data.getColumns = getColumns;
			}
			let stream = serializer.serializer.serializeStream(response_data, response_object);
			if (can_compress) {
				response_object.headers.set('Content-Encoding', 'br');
				stream = stream.pipe(
					createBrotliCompress({
						params: {
							[constants.BROTLI_PARAM_MODE]:
								serializer.type.includes('json') || serializer.type.includes('text')
									? constants.BROTLI_MODE_TEXT
									: constants.BROTLI_MODE_GENERIC,
							[constants.BROTLI_PARAM_QUALITY]: 2, // go fast
						},
					})
				);
			}
			return stream;
		}
		response_body = serializer.serializer.serialize(response_data, response_object);
	}
	if (can_compress && response_body?.length > COMPRESSION_THRESHOLD) {
		// TODO: Only do this if the size is large and we can cache the result (otherwise use logic above)
		response_object.headers.set('Content-Encoding', 'br');
		// if we have a single buffer (or string) we compress in a single async call
		return new Promise((resolve, reject) =>
			brotliCompress(response_body, (err, data) => {
				if (err) reject(err);
				else resolve(data);
			})
		);
	}
	return response_body;
}

let asyncSerializations: Promise<void>[];
/**
 * Serialize a message, may be use multiple times (like with WebSockets)
 * @param message
 * @param request
 * @returns {*}
 */
export function serializeMessage(
	message: any,
	request?: Request,
	inAsyncContinuation?: boolean
): Buffer | string | Promise<Buffer | string> {
	if (message?.contentType != null && message.data != null) return message.data;
	asyncSerializations = inAsyncContinuation ? undefined : [];
	try {
		let serialized: Buffer | string;
		if (request) {
			let serialize = request.serialize;
			if (serialize) serialized = serialize(message);
			else {
				const serializer = findBestSerializer(request);
				serialize = request.serialize = serializer.serializer.serialize;
				serialized = serialize(message);
			}
		} else {
			serialized = JSONStringify(message);
		}
		if (asyncSerializations?.length > 0)
			// if there were any serialization attempts that must wait for async work to be done, we wait now and then retry the serialization
			return (asyncSerializations.length === 1 ? asyncSerializations[0] : Promise.all(asyncSerializations)).then(() =>
				serializeMessage(message, request, true)
			);
		return serialized;
	} finally {
		asyncSerializations = undefined;
	}
}

/**
 * This can be called during serialization indicating that an object requires asynchronous serialization (or async completion of a task prior to serialization) to be properly serialized.
 * A promise for when the object is ready to be serialized. Typically serialization will be re-executed and this object should be ready to be synchronously serialized
 * @param promiseToSerialize
 */
export function asyncSerialization(promiseToSerialize: Promise<any>) {
	if (asyncSerializations) asyncSerializations.push(promiseToSerialize);
	else throw new Error('Unable to serialize asynchronously');
}
export function hasAsyncSerialization() {
	return !!asyncSerializations;
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const buffers = [];
		stream.on('data', (data) => buffers.push(data));
		stream.on('end', () => resolve(Buffer.concat(buffers)));
		stream.on('error', reject);
	});
}

/**
 * An object based representation of a content-type header string.
 * The parameters `charset` and `boundary` have been added to the type as
 * they are common parameters for the `Content-Type` header, but HTTP specifies
 * that any parameter can be included (hence the `[k: string]: string`).
 *
 * Use `parseContentType(content_type: string)` to create this object.
 */
type ContentType = {
	type: string;
	parameters?: { charset?: string; boundary?: string; [k: string]: string };
};

const BUFFER_ENCODINGS = [
	'ascii',
	'utf8',
	'utf-8',
	'utf16le',
	'utf-16le',
	'ucs2',
	'ucs-2',
	'base64',
	'base64url',
	'latin1',
	'binary',
	'hex',
];
function isBufferEncoding(value: string): value is BufferEncoding {
	return BUFFER_ENCODINGS.includes(value);
}

/**
 * Parse the content-type header for the type and parameters.
 * @param content_type
 */
function parseContentType(content_type: string): ContentType {
	// Get the first `;` character to separate the type from the parameters
	const parameters_start = content_type.indexOf(';');
	let parameters: ContentType['parameters'];

	// If the `;` exists, then parse the parameters
	if (parameters_start > -1) {
		parameters = {};
		// Parameters are separated by `;` and key-value pairs are separated by `=`
		// i.e. `multipart/form-data; charset=UTF-8; boundary=---123`
		const parts = content_type.slice(parameters_start + 1).split(';');
		for (const part of parts) {
			const [key, value] = part.split('=');
			parameters[key.trim()] = value.trim();
		}
		content_type = content_type.slice(0, parameters_start);
	}

	return { type: content_type, parameters };
}

/**
 * Given a content-type header string, get a deserializer function that can be used to parse the body.
 */
export function getDeserializer(content_type_string: string, streaming: false): Deserialize;
export function getDeserializer(
	content_type_string: string,
	streaming: true
): (stream: Readable) => Promise<ReturnType<Deserialize>>;
export function getDeserializer(
	content_type_string: string = '',
	streaming: boolean = false
): Deserialize | ((stream: Readable) => Promise<ReturnType<Deserialize>>) {
	const content_type = parseContentType(content_type_string);

	const deserialize =
		(content_type.type && media_types.get(content_type.type)?.deserialize) || deserializerUnknownType(content_type);

	return streaming ? (stream: Readable) => streamToBuffer(stream).then(deserialize) : deserialize;
}

function deserializerUnknownType(content_type: ContentType): Deserialize {
	// TODO: store the content-disposition too

	if (content_type.type.startsWith('text/')) {
		// convert the data to a string since it is text (using the provided charset if specified)
		if (content_type.parameters?.charset && !isBufferEncoding(content_type.parameters.charset)) {
			logger.info(`Unknown Buffer encoding ${content_type.parameters.charset} in content-type. Proceeding anyways.`);
		}
		return (data) => ({
			contentType: content_type.type,
			// @ts-expect-error We are okay with passing whatever the user has specified as the encoding to the `toString` method
			data: data.toString(content_type.parameters?.charset || 'utf-8'),
		});
	} else if (content_type.type === 'application/octet-stream') {
		// use this type as a way of directly transferring binary data (since that is what it means)
		return (data) => data;
	} else {
		return (data) => {
			if (content_type.type === '') {
				// try to parse as JSON if no content type
				try {
					// if the first byte is `{` then it is likely JSON
					if (data?.[0] === 123) return JSONParse(data);
					// eslint-disable-next-line sonarjs/no-ignored-exceptions
				} catch (error) {
					// continue if cannot parse as JSON
				}
			}
			// else record the type and binary data as a pair
			return { contentType: content_type.type || 'application/octet-stream', data };
		};
	}
}

function transformIterable(iterable, transform) {
	return {
		[Symbol.asyncIterator]() {
			const iterator = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
			return {
				next() {
					const step = iterator.next();
					if (step.then) {
						return step.then((step) => ({
							value: transform(step.value),
							done: step.done,
						}));
					}
					return {
						value: transform(step.value),
						done: step.done,
					};
				},
				return(value) {
					return iterator.return(value);
				},
				throw(error) {
					return iterator.throw(error);
				},
			};
		},
	};
}

/**
 * Converts JS objects/arrays/iterators to a CSV stream. Should support iterators with full backpressure handling
 * @param data
 * @returns stream
 */
export function toCsvStream(data, columns) {
	// ensure that we pass it an iterable
	const read_stream = stream.Readable.from(data?.[Symbol.iterator] || data?.[Symbol.asyncIterator] ? data : [data]);
	const options = {};
	if (columns)
		options.fields = columns.map((column) => ({
			label: column,
			value: column,
		}));
	const transform_options = { objectMode: true };
	// Create a json2csv stream transform.
	const json2csv = new Transform(options, transform_options);
	// Pipe the data read stream through json2csv which converts it to CSV
	return read_stream.pipe(json2csv);
}
