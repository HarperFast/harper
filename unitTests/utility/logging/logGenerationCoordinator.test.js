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
				logPaths: ['/a/component/own.log'],
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

		// The batched form retention uses is the inverse, and each sink judges its own path: release
		// every descriptor that is not on the live generation of the file it is writing.
		transport.deliverRotation({ request: 'r1', stale: true });
		assert.strictEqual(closed, 1, 'expected the live generation to be kept');
		coordinator.unregisterLogSink(logPath);
		coordinator.registerLogSink(logPath, {
			identity: () => ({ ino: held.ino + 1, dev: held.dev }),
			close: () => closed++,
		});
		transport.deliverRotation({ request: 'r2', stale: true });
		assert.strictEqual(closed, 2, 'expected a descriptor on an older generation to be released');
		coordinator.unregisterLogSink(logPath);

		// A filesystem that reports ino 0 cannot prove a descriptor is on the live generation, and
		// answering "released" without releasing is what lets an archive be destroyed under a peer.
		coordinator.registerLogSink(logPath, { identity: () => ({ ino: 0, dev: 0 }), close: () => closed++ });
		transport.deliverRotation({ request: 'r3', stale: true });
		assert.strictEqual(closed, 3, 'expected an indistinguishable descriptor to be released');
		coordinator.unregisterLogSink(logPath);

		// A log whose file is gone can only be holding an archived inode.
		fs.removeSync(logPath);
		coordinator.registerLogSink(logPath, { identity: () => ({ ino: held.ino, dev: held.dev }), close: () => closed++ });
		transport.deliverRotation({ request: 'r4', stale: true });
		assert.strictEqual(closed, 4, 'expected a descriptor on a vanished path to be released');
		coordinator.unregisterLogSink(logPath);
	});

	it('releases stale descriptors for every log it writes, in one request', () => {
		// The archive directory holds the archives of every component and external log sharing it, so a
		// request scoped to one path would leave the others' archives destroyable under a live peer.
		const transport = fakeTransport();
		const dir = path.join(TEST_ROOT, `multiSink${caseNumber++}`);
		fs.mkdirpSync(dir);
		const closed = [];
		const held = {};
		for (const name of ['hdb.log', 'component.log', 'external.log']) {
			const logPath = path.join(dir, name);
			fs.writeFileSync(logPath, `${name} contents\n`);
			held[name] = fs.statSync(logPath);
			coordinator.registerLogSink(logPath, {
				// hdb.log is on its live generation; the other two hold an older inode.
				identity: () => (name === 'hdb.log' ? held[name] : { ino: held[name].ino + 1000, dev: held[name].dev }),
				close: () => closed.push(name),
			});
		}

		transport.deliverRotation({ request: 'multi', stale: true });

		assert.deepStrictEqual(closed.sort(), ['component.log', 'external.log']);
		for (const name of ['hdb.log', 'component.log', 'external.log']) {
			coordinator.unregisterLogSink(path.join(dir, name));
		}
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
		const unproven = await coordinator.requestStaleDescriptorRelease();
		assert.strictEqual(unproven.released, false);
		assert.strictEqual(stalled.broadcasts.at(-1).stale, true);

		fakeTransport();
		const proven = await coordinator.requestStaleDescriptorRelease();
		assert.strictEqual(proven.released, true);
		// A peer's own registered log paths come back with its answer: a component loads in a worker,
		// so the thread that runs retention only learns about that log this way.
		assert.ok(proven.liveLogPaths.has('/a/component/own.log'), 'expected a peer-reported live log path');
	});

	it('leaves the plain archive authoritative when compression fails', async () => {
		fakeTransport();
		const { generation } = newGeneration();
		fs.removeSync(generation.archivePath);
		await assert.rejects(publishArchivedGeneration(generation, true));
		assert.ok(!fs.pathExistsSync(`${generation.archivePath}.gz`), 'expected no partial .gz to be published');
	});
});
