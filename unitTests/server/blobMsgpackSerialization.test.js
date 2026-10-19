const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Unpackr, addExtension, unpack } = require('msgpackr');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { createBlob } = require('#src/resources/blob');
const { handleApplication } = require('#src/server/REST');
const { serialize, serializeMessage } = require('#src/server/serverHelpers/contentTypes');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

const BLOB_HEADER_SIZE = 8;
const EXTERNAL_FILE_ARRAY_HEADER = 0x91;
const FILE_BLOB_PAYLOAD_SIZE = 40_000;
const INLINE_BLOB_PAYLOAD_SIZE = 1024;
const MAP16_HEADER = 0xde;

describe('Blob MessagePack serialization without reentering defaultPackr', () => {
	let BlobRecordTable;
	let resources;
	let restHandler;
	let restWsHandler;
	let extensionsArray;
	let originalBlobUnpack;
	const optionsDecoder = new Unpackr({ mapsAsObjects: true });

	function decodeExternalBlobExt(extBuffer) {
		if (extBuffer[0] === EXTERNAL_FILE_ARRAY_HEADER) {
			const dataStart = extBuffer.length - FILE_BLOB_PAYLOAD_SIZE;
			const [options] = optionsDecoder.unpack(extBuffer.subarray(0, dataStart - BLOB_HEADER_SIZE));
			return {
				...options,
				header: Buffer.from(extBuffer.subarray(dataStart - BLOB_HEADER_SIZE, dataStart)),
				data: Buffer.from(extBuffer.subarray(dataStart)),
			};
		}
		return originalBlobUnpack(extBuffer);
	}

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		// msgpackr invokes `extensions[type](...)` as a method on its internal `extensions` array,
		// so `this` inside an unpack handler is that array. That lets the test decode the external-file
		// branch of extension 11 (`blobPackr.pack([options])` + raw file header/body) via `unpack()`
		// and restore `resources/blob.ts`'s registered handler afterwards.
		addExtension({
			type: 127,
			unpack() {
				extensionsArray = this;
			},
		});
		unpack(Buffer.from([0xc7, 0x01, 0x7f, 0x00]));
		delete extensionsArray[127];
		originalBlobUnpack = extensionsArray[11];
		extensionsArray[11] = decodeExternalBlobExt;

		BlobRecordTable = table({
			table: 'BlobMsgpackRecord',
			database: 'test_blob_msgpack',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'data', type: 'Blob' },
			],
		});
		BlobRecordTable.loadAsInstance = false;

		resources = new Resources();
		resources.set('BlobMsgpackRecord', BlobRecordTable, { rest: true, ws: true });

		const scope = {
			resources,
			options: {
				getAll() {
					return {};
				},
				on() {},
			},
			routeFor() {
				return this;
			},
			server: {
				http(handler) {
					restHandler = handler;
				},
				ws(handler) {
					restWsHandler = handler;
				},
				recordActivity() {},
			},
		};
		handleApplication(scope);
	});

	after(function () {
		if (extensionsArray && originalBlobUnpack) {
			extensionsArray[11] = originalBlobUnpack;
		}
	});

	function makeHeaders(headerObj) {
		const headers = new Headers(headerObj);
		headers.asObject = headerObj;
		return headers;
	}

	it('encodes a record with a file-backed Blob via public MessagePack serializer without stale prefix and decodes with unpack', async () => {
		const payload = Buffer.alloc(FILE_BLOB_PAYLOAD_SIZE, 0x61);
		const recordId = 'serializer-blob-1';
		const blob = await createBlob(payload, { saveBeforeCommit: true, type: 'application/octet-stream' });
		await BlobRecordTable.put({
			id: recordId,
			name: 'serializer-record',
			data: blob,
		});

		const storedRecord = await BlobRecordTable.get(recordId);
		assert.ok(storedRecord, 'Expected stored record to exist');

		const request = { headers: makeHeaders({ accept: 'application/x-msgpack' }) };
		// Leave msgpackr's shared buffer position non-zero, as any earlier response on this thread does.
		await serialize({ warmup: 'prior-msgpack-response' }, request, { headers: new Headers() });

		const frame = Buffer.from(await serialize(storedRecord, request, { headers: new Headers() }));
		assert.strictEqual(
			frame[0],
			MAP16_HEADER,
			`Expected outer msgpack frame to start with map16 header 0xde, got 0x${frame[0].toString(16)}`
		);
		assert.ok(
			frame.length < payload.length + 256,
			`Expected single-record frame length (< ${payload.length + 256}), got ${frame.length}`
		);

		const decoded = unpack(frame);
		assert.strictEqual(decoded.id, recordId);
		assert.strictEqual(decoded.name, 'serializer-record');
		assert.strictEqual(decoded.data.size, payload.length);
		assert.strictEqual(decoded.data.type, 'application/octet-stream');
		assert.deepStrictEqual(decoded.data.data, payload);

		const messageFrame = Buffer.from(await serializeMessage(storedRecord, request));
		assert.strictEqual(messageFrame[0], MAP16_HEADER);
		assert.ok(messageFrame.length < payload.length + 256);
		const decodedMessage = unpack(messageFrame);
		assert.strictEqual(decodedMessage.id, recordId);
		assert.strictEqual(decodedMessage.name, 'serializer-record');
		assert.strictEqual(decodedMessage.data.size, payload.length);
		assert.deepStrictEqual(decodedMessage.data.data, payload);
	});

	it('encodes a record with an inline sub-threshold Blob via public MessagePack serializer without stale prefix and decodes with unpack', async () => {
		const payload = Buffer.alloc(INLINE_BLOB_PAYLOAD_SIZE, 0x64);
		const recordId = 'serializer-inline-blob-1';
		const blob = await createBlob(payload, { saveInRecord: true, type: 'application/octet-stream' });
		await BlobRecordTable.put({
			id: recordId,
			name: 'inline-serializer-record',
			data: blob,
		});

		const storedRecord = await BlobRecordTable.get(recordId);
		assert.ok(storedRecord, 'Expected stored inline-blob record to exist');

		const request = { headers: makeHeaders({ accept: 'application/x-msgpack' }) };
		// Leave msgpackr's shared buffer position non-zero, as any earlier response on this thread does.
		await serialize({ warmup: 'prior-msgpack-response' }, request, { headers: new Headers() });

		const frame = Buffer.from(await serialize(storedRecord, request, { headers: new Headers() }));
		assert.strictEqual(frame[0], MAP16_HEADER);
		assert.ok(frame.length < payload.length + 256);

		const decoded = unpack(frame);
		assert.strictEqual(decoded.id, recordId);
		assert.strictEqual(decoded.name, 'inline-serializer-record');
		assert.ok(decoded.data instanceof Blob);
		assert.strictEqual(decoded.data.size, payload.length);
		assert.strictEqual(decoded.data.type, 'application/octet-stream');
		assert.deepStrictEqual(Buffer.from(await decoded.data.bytes()), payload);

		const messageFrame = Buffer.from(await serializeMessage(storedRecord, request));
		assert.strictEqual(messageFrame[0], MAP16_HEADER);
		assert.ok(messageFrame.length < payload.length + 256);
		const decodedMessage = unpack(messageFrame);
		assert.strictEqual(decodedMessage.id, recordId);
		assert.strictEqual(decodedMessage.name, 'inline-serializer-record');
		assert.ok(decodedMessage.data instanceof Blob);
		assert.strictEqual(decodedMessage.data.size, payload.length);
		assert.deepStrictEqual(Buffer.from(await decodedMessage.data.bytes()), payload);
	});

	it('serves REST GET with Accept: application/x-msgpack on a record with a file-backed Blob', async () => {
		const payload = Buffer.alloc(FILE_BLOB_PAYLOAD_SIZE, 0x62);
		const recordId = 'rest-get-blob-1';
		const blob = await createBlob(payload, { saveBeforeCommit: true, type: 'application/octet-stream' });
		await BlobRecordTable.put({
			id: recordId,
			name: 'rest-get-record',
			data: blob,
		});

		const requestHeaders = makeHeaders({ accept: 'application/x-msgpack' });
		// Leave msgpackr's shared buffer position non-zero, as any earlier response on this thread does.
		await serialize({ warmup: 'prior-msgpack-response' }, { headers: requestHeaders }, { headers: new Headers() });

		const response = await restHandler(
			{
				url: `/BlobMsgpackRecord/${recordId}`,
				method: 'GET',
				headers: requestHeaders,
				protocol: 'http',
				ip: '127.0.0.1',
				user: { role: { permission: { super_user: true } } },
			},
			() => {
				throw new Error('Unexpected fallthrough from REST handler');
			}
		);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.headers.get('content-type'), 'application/x-msgpack');

		let bodyBuffer;
		if (Buffer.isBuffer(response.body) || response.body instanceof Uint8Array) {
			bodyBuffer = Buffer.from(response.body);
		} else {
			const chunks = [];
			for await (const chunk of response.body) {
				chunks.push(Buffer.from(chunk));
			}
			bodyBuffer = Buffer.concat(chunks);
		}
		assert.ok(bodyBuffer.length > payload.length, 'Expected MessagePack body to include the Blob payload');
		assert.ok(
			bodyBuffer.length < payload.length + 256,
			`Expected single-record REST MessagePack body (< ${payload.length + 256}), got ${bodyBuffer.length}`
		);
		assert.strictEqual(
			bodyBuffer[0],
			MAP16_HEADER,
			`Expected REST GET MessagePack body to start with 0xde map16 header, got 0x${bodyBuffer[0].toString(16)}`
		);

		const decoded = unpack(bodyBuffer);
		assert.strictEqual(decoded.id, recordId);
		assert.strictEqual(decoded.name, 'rest-get-record');
		assert.strictEqual(decoded.data.size, payload.length);
		assert.strictEqual(decoded.data.type, 'application/octet-stream');
		assert.deepStrictEqual(decoded.data.data, payload);
	});

	it('delivers valid MessagePack frames over a WebSocket subscription for a record with a file-backed Blob', async () => {
		const payload = Buffer.alloc(FILE_BLOB_PAYLOAD_SIZE, 0x63);
		const recordId = 'ws-sub-blob-1';

		const sentFrames = [];
		const ws = new EventEmitter();
		ws.readyState = 1;
		ws._socket = { writableNeedDrain: false };
		ws.send = (frame) => {
			sentFrames.push(Buffer.from(frame));
		};
		ws.close = () => {};

		const request = {
			url: `/BlobMsgpackRecord/${recordId}`,
			headers: makeHeaders({ accept: 'application/x-msgpack' }),
			requestedAt: Date.now(),
			user: { role: { permission: { super_user: true } } },
		};

		const wsSession = restWsHandler(ws, request, Promise.resolve());
		try {
			await new Promise((resolve) => setImmediate(resolve));

			await BlobRecordTable.put({
				id: recordId,
				name: 'ws-plain-record',
			});
			await waitFor(() => sentFrames.length >= 1, 5000);

			const plainFrame = sentFrames[0];
			const decodedPlainEvent = unpack(plainFrame);
			assert.strictEqual(decodedPlainEvent.type, 'put');
			assert.strictEqual(decodedPlainEvent.id, recordId);
			assert.strictEqual(decodedPlainEvent.value.id, recordId);
			assert.strictEqual(decodedPlainEvent.value.name, 'ws-plain-record');

			const blob = await createBlob(payload, { saveBeforeCommit: true, type: 'application/octet-stream' });
			await BlobRecordTable.put({
				id: recordId,
				name: 'ws-blob-record',
				data: blob,
			});

			await waitFor(() => sentFrames.length >= 2, 5000);

			const eventFrame = sentFrames[1];
			assert.strictEqual(
				eventFrame[0],
				MAP16_HEADER,
				`Expected WebSocket MessagePack frame to start with 0xde map16 header, got 0x${eventFrame[0].toString(16)}`
			);
			assert.ok(
				eventFrame.length < payload.length + 256,
				`Expected single-event WebSocket MessagePack frame (< ${payload.length + 256}), got ${eventFrame.length}`
			);

			const decodedEvent = unpack(eventFrame);
			assert.strictEqual(decodedEvent.type, 'put');
			assert.strictEqual(decodedEvent.id, recordId);
			assert.strictEqual(decodedEvent.value.id, recordId);
			assert.strictEqual(decodedEvent.value.name, 'ws-blob-record');
			assert.strictEqual(decodedEvent.value.data.size, payload.length);
			assert.strictEqual(decodedEvent.value.data.type, 'application/octet-stream');
			assert.deepStrictEqual(decodedEvent.value.data.data, payload);
		} finally {
			ws.emit('close');
			await wsSession;
		}
	});
});
