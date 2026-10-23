'use strict';

// Unit tests for the payload operations in deploymentOperations:
//   - `handleGetDeploymentPayload()` — streams the stored tarball as raw bytes with
//     download headers attached (never base64; see the handler's V8 string-cap note).
//   - `handleDeleteDeploymentPayload()` — nulls payload_blob on a terminal row to reclaim
//     storage cluster-wide, retaining the row metadata + event_log as the audit trail.
//
// The table layer is a tiny Map-backed mock on `databases.system`, mirroring
// deploymentRecorder.test.js.

const assert = require('node:assert');
const { Readable } = require('node:stream');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { handleGetDeploymentPayload, handleDeleteDeploymentPayload } = require('#src/components/deploymentOperations');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');
const { waitFor } = require('../waitFor.js');

const DEPLOYMENT_TABLE = terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;
const SUPER_USER = { username: 'admin', role: { permission: { super_user: true } } };
const NON_SUPER_USER = { username: 'operator', role: { permission: { super_user: false } } };

function installMockDeploymentTable() {
	const rows = new Map();
	const puts = [];
	const mock = {
		rows,
		puts,
		async get(id) {
			return rows.get(id);
		},
		async put(row) {
			puts.push(row);
			rows.set(row.deployment_id, row);
		},
	};
	if (!databases.system) databases.system = {};
	const prior = databases.system[DEPLOYMENT_TABLE];
	databases.system[DEPLOYMENT_TABLE] = mock;
	return {
		mock,
		restore() {
			databases.system[DEPLOYMENT_TABLE] = prior;
		},
	};
}

// Minimal stand-in for a stored Blob: stream() yields the bytes as a web ReadableStream,
// matching resources/blob.ts's stream() signature.
function mockBlob(bytes) {
	return {
		size: bytes.length,
		stream() {
			return Readable.toWeb(Readable.from([bytes]));
		},
	};
}

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe('handleGetDeploymentPayload', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('rejects a caller with no hdb_user as forbidden, before any deployment lookup', async () => {
		await assert.rejects(handleGetDeploymentPayload({ deployment_id: 'd1' }), (err) => {
			assert.match(err.message, /restricted to super_user/);
			assert.strictEqual(err.statusCode, 403);
			return true;
		});
	});

	it('rejects a non-super_user role as forbidden — cannot be delegated via a role grant', async () => {
		installed.mock.rows.set('d1', { deployment_id: 'd1', status: 'success', payload_blob: mockBlob(Buffer.from('x')) });
		await assert.rejects(handleGetDeploymentPayload({ deployment_id: 'd1', hdb_user: NON_SUPER_USER }), (err) => {
			assert.match(err.message, /restricted to super_user/);
			assert.strictEqual(err.statusCode, 403);
			return true;
		});
	});

	it('rejects a missing deployment_id (for a super_user caller)', async () => {
		await assert.rejects(handleGetDeploymentPayload({ hdb_user: SUPER_USER }), /'deployment_id' is required/);
	});

	it('404s on an unknown deployment_id', async () => {
		await assert.rejects(handleGetDeploymentPayload({ deployment_id: 'nope', hdb_user: SUPER_USER }), (err) => {
			assert.match(err.message, /No deployment found/);
			assert.strictEqual(err.statusCode, 404);
			return true;
		});
	});

	it('404s when the payload has been reclaimed', async () => {
		installed.mock.rows.set('d1', { deployment_id: 'd1', status: 'success', payload_blob: null });
		await assert.rejects(handleGetDeploymentPayload({ deployment_id: 'd1', hdb_user: SUPER_USER }), (err) => {
			assert.match(err.message, /No payload is stored/);
			assert.strictEqual(err.statusCode, 404);
			return true;
		});
	});

	it('streams the raw payload bytes with download headers', async () => {
		const bytes = Buffer.from('tarball-bytes-here');
		installed.mock.rows.set('d1', { deployment_id: 'd1', status: 'success', payload_blob: mockBlob(bytes) });
		const stream = await handleGetDeploymentPayload({ deployment_id: 'd1', hdb_user: SUPER_USER });
		assert.ok(stream instanceof Readable, 'must be a Node Readable so serverHandlers pipes it');
		assert.strictEqual(stream.headers.get('content-type'), 'application/octet-stream');
		assert.match(stream.headers.get('content-disposition'), /deployment-d1\.tar\.gz/);
		assert.deepStrictEqual(await collect(stream), bytes);
	});
});

describe('handleDeleteDeploymentPayload', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('rejects a missing deployment_id', async () => {
		await assert.rejects(handleDeleteDeploymentPayload({}), /'deployment_id' is required/);
	});

	it('404s on an unknown deployment_id', async () => {
		await assert.rejects(handleDeleteDeploymentPayload({ deployment_id: 'nope' }), (err) => {
			assert.strictEqual(err.statusCode, 404);
			return true;
		});
	});

	it('409s on a non-terminal deployment (blob may still be replicating to peers)', async () => {
		installed.mock.rows.set('d1', { deployment_id: 'd1', status: 'pending', payload_blob: mockBlob(Buffer.from('x')) });
		await assert.rejects(handleDeleteDeploymentPayload({ deployment_id: 'd1' }), (err) => {
			assert.match(err.message, /not in a terminal state/);
			assert.strictEqual(err.statusCode, 409);
			return true;
		});
		assert.strictEqual(installed.mock.puts.length, 0, 'must not write the row');
	});

	it('nulls the blob, retains metadata, and appends an audit event', async () => {
		const original = {
			deployment_id: 'd1',
			project: 'my-app',
			status: 'success',
			payload_blob: mockBlob(Buffer.from('x')),
			payload_size: 12345,
			payload_hash: 'abc',
			event_log: [{ t: 1, event: 'phase', data: { phase: 'success' } }],
		};
		installed.mock.rows.set('d1', original);
		const result = await handleDeleteDeploymentPayload({
			deployment_id: 'd1',
			hdb_user: { username: 'admin' },
		});
		assert.strictEqual(result.freed_bytes, 12345);
		assert.strictEqual(result.deployment_id, 'd1');

		const written = installed.mock.puts[0];
		assert.strictEqual(written.payload_blob, null);
		assert.strictEqual(written.payload_size, 12345, 'metadata is retained');
		assert.strictEqual(written.payload_hash, 'abc');
		const dropEvent = written.event_log.at(-1);
		assert.strictEqual(dropEvent.event, 'payload_dropped');
		assert.deepStrictEqual(dropEvent.data, { payload_size: 12345, deleted_by: 'admin' });

		// The fetched row object must not be mutated in place (it may be a shared/cached record).
		assert.notStrictEqual(written, original);
		assert.ok(original.payload_blob, 'original row untouched');
		assert.strictEqual(original.event_log.length, 1);
	});

	it('is idempotent when the payload is already gone', async () => {
		installed.mock.rows.set('d1', { deployment_id: 'd1', status: 'failed', payload_blob: null });
		const result = await handleDeleteDeploymentPayload({ deployment_id: 'd1' });
		assert.strictEqual(result.freed_bytes, 0);
		assert.match(result.message, /No payload stored/);
		assert.strictEqual(installed.mock.puts.length, 0, 'no write on the idempotent path');
	});
});

describe('handleGetDeployment live tail (harper#3062)', () => {
	const { handleGetDeployment } = require('#src/components/deploymentOperations');
	const { DeploymentRecorder } = require('#src/components/deploymentRecorder');
	const { ProgressEmitter } = require('#src/server/serverHelpers/progressEmitter');
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('forwards live events, sends no internal event, and ends with the terminal row once the deploy finishes', async () => {
		const deployEmitter = new ProgressEmitter();
		const recorder = await DeploymentRecorder.create({ project: 'p', emitter: deployEmitter });
		const sse = new ProgressEmitter();
		const forwarded = [];
		sse.subscribe((event) => forwarded.push(event.event));

		let settled = false;
		const tail = handleGetDeployment({ deployment_id: recorder.deploymentId, progress: sse }).then((row) => {
			settled = true;
			return row;
		});
		await new Promise((resolve) => setImmediate(resolve));
		deployEmitter.emit('phase', { phase: 'prepare', status: 'start' });
		deployEmitter.emit('phase', { phase: 'success', status: 'done' });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(settled, false, 'the tail waits for the recorder, not for a phase event');

		await recorder.finish('success');
		const row = await tail;
		assert.strictEqual(row.status, 'success');
		assert.ok(forwarded.length > 0);
		assert.ok(
			forwarded.every((name) => !name.startsWith('_')),
			`forwarded: ${forwarded.join(', ')}`
		);
	});

	it('waits for a terminal write already under way when the tail arrives', async () => {
		let releaseTerminalWrite;
		const recorder = await DeploymentRecorder.create({ project: 'p', emitter: new ProgressEmitter() });
		const put = installed.mock.put;
		installed.mock.put = async (row) => {
			if (row.status === 'success') await new Promise((resolve) => (releaseTerminalWrite = resolve));
			return put.call(installed.mock, row);
		};
		const finishing = recorder.finish('success');
		await waitFor(() => releaseTerminalWrite, 2000);
		const tail = handleGetDeployment({ deployment_id: recorder.deploymentId, progress: new ProgressEmitter() });
		await new Promise((resolve) => setImmediate(resolve));
		releaseTerminalWrite();
		await finishing;
		assert.strictEqual((await tail).status, 'success');
	});

	it('stops waiting when the SSE client disconnects', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p', emitter: new ProgressEmitter() });
		const sse = new ProgressEmitter();
		const controller = new AbortController();
		sse.signal = controller.signal;
		const tail = handleGetDeployment({ deployment_id: recorder.deploymentId, progress: sse });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		const row = await tail;
		assert.strictEqual(row.status, 'pending');
		await recorder.finish('success');
	});
});
