const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Packr, addExtension, unpack } = require('msgpackr');
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

describe('Blob MessagePack serialization without reentering defaultPackr', () => {
	let BlobRecordTable;
	let resources;
	let restHandler;
	let restWsHandler;
	let extensionsArray;
	let originalBlobUnpack;
	class PrefixUnpackr extends Packr {
		unpackPrefix(extBuffer) {
			this._inSaveState = false;
			return this.unpack(extBuffer);
		}
		unpack(source, options) {
			if (!this._inSaveState) {
				this._inSaveState = true;
				return super.unpack(source, options);
			}
			if (this._readingElement) {
				return super.unpack(source, options);
			}
			this._readingElement = true;
			try {
				let value;
				let endOffset = 0;
				super.unpackMultiple(source, (val, _start, end) => {
					value = val;
					endOffset = end;
					return false;
				});
				return { value, endOffset };
			} finally {
				this._readingElement = false;
			}
		}
	}
	const optionsDecoder = new PrefixUnpackr({ copyBuffers: true, mapsAsObjects: true });

	function decodeExternalBlobExt(extBuffer) {
		if (extBuffer[0] === EXTERNAL_FILE_ARRAY_HEADER) {
			const { value, endOffset } = optionsDecoder.unpackPrefix(extBuffer);
			const options = value[0];
			return {
				...options,
				header: Buffer.from(extBuffer.subarray(endOffset, endOffset + BLOB_HEADER_SIZE)),
				data: Buffer.from(extBuffer.subarray(endOffset + BLOB_HEADER_SIZE)),
			};
		}
		return originalBlobUnpack(extBuffer);
	}

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		// Capture msgpackr's extension table so we can decode the external-file branch
		// of extension 11 (`pack([options])` + raw file header/body) via `unpack()` and
		// restore `resources/blob.ts`'s registered unpacker afterwards.
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
		const payload = Buffer.alloc(40_000, 0x61);
		const recordId = 'serializer-blob-1';
		const blob = await createBlob(payload, { saveBeforeCommit: true, type: 'application/octet-stream' });
		await BlobRecordTable.put({
			id: recordId,
			name: 'serializer-record',
			data: blob,
		});

		const storedRecord = await BlobRecordTable.get(recordId);
		assert.ok(storedRecord, 'Expected stored record to exist');

		// Advance msgpackr's shared module-level target/position with a structured-record Packr
		// (matching storage/control-frame writes that precede public serialization in production).
		const priorPackr = new Packr();
		priorPackr.pack({ type: 'subscription_ack', id: 'sub-1', timestamp: 1700000000000 });

		const request = { headers: makeHeaders({ accept: 'application/x-msgpack' }) };
		const frame = Buffer.from(await serialize(storedRecord, request, { headers: new Headers() }));
		assert.notEqual(
			frame[0],
			0x40,
			`Expected outer msgpack frame to start with a map header, not stale 0x40 prefix (got 0x${frame[0].toString(16)})`
		);

		const decoded = unpack(frame);
		assert.equal(decoded.id, recordId);
		assert.equal(decoded.name, 'serializer-record');
		assert.equal(decoded.data.size, payload.length);
		assert.equal(decoded.data.type, 'application/octet-stream');
		assert.deepEqual(decoded.data.data, payload);

		const messageFrame = Buffer.from(await serializeMessage(storedRecord, request));
		assert.notEqual(messageFrame[0], 0x40);
		const decodedMessage = unpack(messageFrame);
		assert.equal(decodedMessage.id, recordId);
		assert.equal(decodedMessage.name, 'serializer-record');
		assert.equal(decodedMessage.data.size, payload.length);
		assert.deepEqual(decodedMessage.data.data, payload);
	});

	it('serves REST GET with Accept: application/x-msgpack on a record with a file-backed Blob', async () => {
		const payload = Buffer.alloc(40_000, 0x62);
		const recordId = 'rest-get-blob-1';
		const blob = await createBlob(payload, { saveBeforeCommit: true, type: 'application/octet-stream' });
		await BlobRecordTable.put({
			id: recordId,
			name: 'rest-get-record',
			data: blob,
		});

		const response = await restHandler(
			{
				url: `/BlobMsgpackRecord/${recordId}`,
				method: 'GET',
				headers: makeHeaders({ accept: 'application/x-msgpack' }),
				protocol: 'http',
				ip: '127.0.0.1',
				user: { role: { permission: { super_user: true } } },
			},
			() => {
				throw new Error('Unexpected fallthrough from REST handler');
			}
		);

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'application/x-msgpack');

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
		assert.notEqual(
			bodyBuffer[0],
			0x40,
			`Expected REST GET MessagePack body not to start with stale 0x40 prefix (got 0x${bodyBuffer[0].toString(16)})`
		);

		const decoded = unpack(bodyBuffer);
		assert.equal(decoded.id, recordId);
		assert.equal(decoded.name, 'rest-get-record');
		assert.equal(decoded.data.size, payload.length);
		assert.equal(decoded.data.type, 'application/octet-stream');
		assert.deepEqual(decoded.data.data, payload);
	});

	it('delivers valid MessagePack frames over a WebSocket subscription for a record with a file-backed Blob', async () => {
		const payload = Buffer.alloc(40_000, 0x63);
		const recordId = 'ws-sub-blob-1';

		const sentFrames = [];
		const ws = new EventEmitter();
		ws.readyState = 1; // OPEN
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
		// Yield briefly so resource.connect(subscribe) registers its listener before writes
		await new Promise((resolve) => setImmediate(resolve));

		// Frame 1: plain record without a Blob
		await BlobRecordTable.put({
			id: recordId,
			name: 'ws-plain-record',
		});
		await waitFor(() => sentFrames.length >= 1, 5000);

		const plainFrame = sentFrames[0];
		const decodedPlainEvent = unpack(plainFrame);
		assert.equal(decodedPlainEvent.type, 'put');
		assert.equal(decodedPlainEvent.id, recordId);
		assert.equal(decodedPlainEvent.value.id, recordId);
		assert.equal(decodedPlainEvent.value.name, 'ws-plain-record');

		// Frame 2: record with a 40KB file-backed Blob
		const blob = await createBlob(payload, { saveBeforeCommit: true, type: 'application/octet-stream' });
		await BlobRecordTable.put({
			id: recordId,
			name: 'ws-blob-record',
			data: blob,
		});

		await waitFor(() => sentFrames.length >= 2, 5000);

		const eventFrame = sentFrames[1];
		assert.notEqual(
			eventFrame[0],
			0x40,
			`Expected WebSocket MessagePack frame not to start with stale 0x40 prefix (got 0x${eventFrame[0].toString(16)})`
		);

		const decodedEvent = unpack(eventFrame);
		assert.equal(decodedEvent.type, 'put');
		assert.equal(decodedEvent.id, recordId);
		assert.equal(decodedEvent.value.id, recordId);
		assert.equal(decodedEvent.value.name, 'ws-blob-record');
		assert.equal(decodedEvent.value.data.size, payload.length);
		assert.equal(decodedEvent.value.data.type, 'application/octet-stream');
		assert.deepEqual(decodedEvent.value.data.data, payload);

		ws.emit('close');
		await wsSession;
	});
});
