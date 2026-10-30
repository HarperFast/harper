// The checkpoint origin-state read (`captureCertifiedFloors`, the same `readOriginStates` scan admission runs):
// 16 peer rows of 16 level-2 origins each, with BENCH_COPY_BOUND_ROWS `[copyBound, peer]` rows beside them.
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { persistOriginClosedFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { captureCertifiedFloors } = require('#src/resources/subscriptionCheckpoint');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const PEERS = 16;
const ORIGINS = 16;
const COPY_BOUND_ROWS = Number(process.env.BENCH_COPY_BOUND_ROWS ?? 0);
const ITERATIONS = 20_000;

describe('checkpoint origin-state read', function () {
	it(`captures certified floors over ${PEERS}x${ORIGINS} route entries and ${COPY_BOUND_ROWS} copy bound rows`, async function () {
		this.timeout(300_000);
		setupTestDBPath();
		setMainIsWorker(true);
		const T = table({
			table: 'CheckpointReadBench',
			database: 'checkpoint_read_bench',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		await T.put('seed', { value: 0 });
		const rootStore = T.primaryStore.rootStore;
		if (typeof rootStore.syncWal !== 'function') rootStore.syncWal = () => Promise.resolve();
		let floor = certifyOriginFloor(rootStore);
		for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
		persistOriginClosedFloor(T.auditStore, floor);
		publishOriginFloor(rootStore, floor);
		floor = getOriginClosedFloor(rootStore).floor;
		const origins = [];
		for (let o = 0; o < ORIGINS; o++) origins.push(getIdOfRemoteNode(`bench-origin-${o}`, T.auditStore));
		for (let p = 0; p < PEERS; p++) {
			const peerId = getIdOfRemoteNode(`bench-peer-${p}`, T.auditStore);
			T.dbisDB.putSync([Symbol.for('seq'), peerId], {
				seqId: floor,
				nodes: origins.map((id) => ({
					id,
					originLogKey: floor,
					closedFloor: floor,
					relayable: true,
					originGeneration: `generation-${id}`,
					fullCoverage: true,
					certifiedFrom: floor - 1000,
				})),
			});
			if (p < COPY_BOUND_ROWS) {
				// below every route's start, so the routes still qualify and only the read is measured
				T.dbisDB.putSync(
					[Symbol.for('copyBound'), peerId],
					Object.fromEntries(origins.map((id) => [id, floor - 2000]))
				);
			}
		}
		const start = process.hrtime.bigint();
		assert.ok(captureCertifiedFloors(T.auditStore, T.dbisDB), 'every origin qualifies');
		const firstNs = Number(process.hrtime.bigint() - start);
		for (let i = 0; i < 1000; i++) captureCertifiedFloors(T.auditStore, T.dbisDB);
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < ITERATIONS; i++) captureCertifiedFloors(T.auditStore, T.dbisDB);
		const perOpNs = Number(process.hrtime.bigint() - t0) / ITERATIONS;
		console.log(
			`checkpoint read: copyBoundRows=${COPY_BOUND_ROWS} first=${(firstNs / 1000).toFixed(0)}us warm=${(perOpNs / 1000).toFixed(1)}us/op`
		);
	});
});
