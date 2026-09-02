'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const coordinator = require('#src/utility/logging/logGenerationCoordinator');
const {
	isArchivePendingQuiescence,
	publishArchivedGeneration,
	retryPendingGenerations,
	rotateLogFileSync,
} = require('#src/utility/logging/logRotation');

const TEST_ROOT = path.join(__dirname, 'generationCoordinatorLogs');

// Stands in for the thread mesh manageThreads injects, so the acknowledgement protocol can be driven
// deterministically instead of by real worker timing.
function fakeTransport({ peers = [1, 2], autoRespond = true, quiescenceTimeout = 50 } = {}) {
	const handlers = new Map();
	const transport = {
		threadId: 0,
		quiescenceTimeout,
		broadcasts: [],
		broadcast(message) {
			transport.broadcasts.push(message);
			if (!autoRespond) return;
			for (const peer of peers) transport.respond(peer, message.request);
		},
		sendToThread() {},
		onMessage(type, handler) {
			handlers.set(type, handler);
		},
		onThreadExit(handler) {
			transport.exitHandler = handler;
		},
		peerThreadIds() {
			return peers;
		},
		respond(threadId, request) {
			handlers.get(coordinator.LOG_GENERATION_CLOSED)({
				type: coordinator.LOG_GENERATION_CLOSED,
				request,
				threadId,
			});
		},
		deliverRotation(message) {
			handlers.get(coordinator.LOG_GENERATION_ROTATED)(message);
		},
	};
	coordinator.setRotationTransport(transport);
	return transport;
}

describe('Test log generation coordinator (#1877)', () => {
	let caseNumber = 0;

	before(() => fs.mkdirpSync(TEST_ROOT));
	after(() => {
		// The coordinator's transport is module state; a fake left installed would follow every later
		// suite in the same mocha process.
		coordinator.setRotationTransport(undefined);
		try {
			fs.removeSync(TEST_ROOT);
		} catch {}
	});

	function newGeneration(contents = 'archived generation contents\n') {
		const dir = path.join(TEST_ROOT, `case${caseNumber++}`);
		const rotatedDir = path.join(dir, 'rotated');
		fs.mkdirpSync(rotatedDir);
		const logPath = path.join(dir, 'hdb.log');
		fs.writeFileSync(logPath, contents);
		return { generation: rotateLogFileSync(logPath, rotatedDir, () => {}), logPath, rotatedDir };
	}

	it('publishes the compressed archive once every peer has acknowledged', async () => {
		fakeTransport();
		const { generation } = newGeneration();
		const published = await publishArchivedGeneration(generation, true);
		assert.ok(published.endsWith('.gz'), `expected a compressed archive, got ${published}`);
		assert.ok(fs.pathExistsSync(published), 'expected the .gz to exist');
		assert.ok(!fs.pathExistsSync(generation.archivePath), 'expected the plain archive to be removed');
		assert.ok(!fs.readdirSync(path.dirname(published)).some((name) => name.endsWith('.tmp')));
	});

	it('keeps the plain archive when a peer never acknowledges', async () => {
		fakeTransport({ autoRespond: false });
		const { generation } = newGeneration();
		const published = await publishArchivedGeneration(generation, true);
		assert.strictEqual(published, generation.archivePath, 'expected the plain archive to stay authoritative');
		assert.ok(fs.pathExistsSync(generation.archivePath), 'expected the plain archive to survive');
		assert.ok(!fs.pathExistsSync(`${generation.archivePath}.gz`), 'expected no .gz to be published');
	});

	it('treats a peer that exits as having released the generation', async () => {
		const transport = fakeTransport({ peers: [1, 2], autoRespond: false });
		const { generation } = newGeneration();
		const published = publishArchivedGeneration(generation, true);
		transport.respond(1, generation.generation);
		transport.exitHandler(2);
		assert.ok((await published).endsWith('.gz'), 'expected worker exit to count as a release');
	});

	it('holds an uncompressed archive back from retention too, not just a compressed one', async () => {
		fakeTransport({ autoRespond: false });
		const { generation } = newGeneration();
		const published = await publishArchivedGeneration(generation, false);
		assert.strictEqual(published, generation.archivePath);
		assert.ok(fs.pathExistsSync(generation.archivePath));
		// Compression is not the only destructive path — retention unlinks archives as well.
		assert.ok(isArchivePendingQuiescence(generation.archivePath));
	});

	it('closes a descriptor that still points at the announced generation', () => {
		const transport = fakeTransport();
		const dir = path.join(TEST_ROOT, `sink${caseNumber++}`);
		fs.mkdirpSync(dir);
		const logPath = path.join(dir, 'hdb.log');
		fs.writeFileSync(logPath, 'held\n');
		const held = fs.statSync(logPath);
		let closed = 0;
		coordinator.registerLogSink(logPath, {
			identity: () => ({ ino: held.ino, dev: held.dev }),
			close: () => closed++,
		});
		transport.deliverRotation({ logPath, request: 'g', ino: held.ino, dev: held.dev, originator: 0 });
		assert.strictEqual(closed, 1, 'expected the sink to be asked to close its descriptor');
		// A generation this sink never held must not close anything.
		transport.deliverRotation({ logPath, request: 'g2', ino: held.ino + 1, dev: held.dev, originator: 0 });
		assert.strictEqual(closed, 1, 'expected a foreign generation to leave the descriptor alone');

		// The batched form retention uses is the inverse: release everything but the live generation.
		transport.deliverRotation({ logPath, request: 'r1', stale: true, keepIno: held.ino, keepDev: held.dev });
		assert.strictEqual(closed, 1, 'expected the live generation to be kept');
		transport.deliverRotation({ logPath, request: 'r2', stale: true, keepIno: held.ino + 1, keepDev: held.dev });
		assert.strictEqual(closed, 2, 'expected a stale descriptor to be released');
		// No live generation to name (the active log is gone) means every descriptor is stale.
		transport.deliverRotation({ logPath, request: 'r3', stale: true });
		assert.strictEqual(closed, 3, 'expected every descriptor to be released when there is no live log');
		coordinator.unregisterLogSink(logPath);
	});

	it('is not required to wait for a sink registered after the announcement', async () => {
		const transport = fakeTransport({ peers: [], autoRespond: false });
		const { generation } = newGeneration();
		assert.strictEqual(transport.peerThreadIds().length, 0);
		assert.ok((await publishArchivedGeneration(generation, true)).endsWith('.gz'));
	});

	it('holds an unproven archive back from retention until a later pass proves it', async () => {
		fakeTransport({ autoRespond: false });
		const { generation } = newGeneration();
		await publishArchivedGeneration(generation, true);
		assert.ok(
			isArchivePendingQuiescence(generation.archivePath),
			'expected retention to be told to leave the unproven archive alone'
		);

		// A later pass, with the peer answering again, is what clears it.
		fakeTransport();
		await retryPendingGenerations();
		assert.ok(!isArchivePendingQuiescence(generation.archivePath), 'expected the retry to clear the archive');
		assert.ok(fs.pathExistsSync(`${generation.archivePath}.gz`), 'expected the retry to compress it');
		assert.ok(!fs.pathExistsSync(generation.archivePath), 'expected the plain archive to be removed');
	});

	it('lets retention proceed only when every peer has released its stale descriptors', async () => {
		const stalled = fakeTransport({ autoRespond: false });
		assert.strictEqual(await coordinator.requestStaleDescriptorRelease('/no/such/log', { ino: 1, dev: 1 }), false);
		assert.strictEqual(stalled.broadcasts.at(-1).keepIno, 1);

		const answering = fakeTransport();
		assert.strictEqual(await coordinator.requestStaleDescriptorRelease('/no/such/log', { ino: 1, dev: 1 }), true);
		assert.strictEqual(answering.broadcasts.at(-1).keepDev, 1);
	});

	it('leaves the plain archive authoritative when compression fails', async () => {
		fakeTransport();
		const { generation } = newGeneration();
		fs.removeSync(generation.archivePath);
		await assert.rejects(publishArchivedGeneration(generation, true));
		assert.ok(!fs.pathExistsSync(`${generation.archivePath}.gz`), 'expected no partial .gz to be published');
	});
});
