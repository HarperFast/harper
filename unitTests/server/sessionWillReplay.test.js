const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const {
	getSession,
	replayOrphanedWills,
	setWillReplayPeerWaitForTests,
} = require('#src/server/DurableSubscriptionsSession');
const { declareWillClaimTable } = require('#src/server/willClaimTable');
const { processIncarnation } = require('#src/server/threads/processIncarnation');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { server } = require('#src/server/Server');
const { localPrincipal } = require('#src/security/user');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

const PREVIOUS_PROCESS = 'previous-process';
const LOCAL_WILL_USER = { username: 'local', _localPrincipal: true };
const SEQ = Symbol.for('seq');

let sequence = 0;
function topicTable() {
	const name = `WillReplayTopic${++sequence}`;
	const T = table({
		table: name,
		database: `will_replay_${name}`,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return { T, name };
}

const wills = () => databases.system.hdb_session_will;
const claims = () => declareWillClaimTable();

async function willRows(clientId) {
	const rows = [];
	for await (const will of wills().search({})) if (will.id[0] === clientId) rows.push(will);
	return rows;
}

async function claimRows(clientId) {
	const rows = [];
	for await (const claim of claims().search([{ attribute: 'clientId', value: clientId }])) rows.push(claim);
	return rows;
}

const willFor = (name, clientId, value) => ({ topic: `${name}/${clientId}`, data: { value }, qos: 0, retain: true });

const connectWithWill = (name, clientId, value) =>
	getSession({ clientId, user: localPrincipal(), clean: true, will: willFor(name, clientId, value) });

/** A connection whose process died: its will row and claim were written, and nothing settled them. */
async function crashedConnection(name, clientId, value) {
	const session = await connectWithWill(name, clientId, value);
	const [row] = await willRows(clientId);
	assert.strictEqual(row.processIncarnation, processIncarnation, 'a will row records the process that wrote it');
	await wills().put({ ...row, processIncarnation: PREVIOUS_PROCESS });
	return session;
}

describe('MQTT will replay at startup', function () {
	this.timeout(30_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('publishes the will a crashed process left once, when its client has not connected since', async () => {
		const { T, name } = topicTable();
		const crashed = await crashedConnection(name, 'gone', 1);
		await replayOrphanedWills();
		assert.strictEqual((await T.get('gone'))?.value, 1);
		assert.deepStrictEqual(await willRows('gone'), []);
		const [claim] = await claimRows('gone');
		assert.deepStrictEqual(claim.id, ['gone', crashed.incarnation]);
		assert.strictEqual(claim.ended, true, 'the dead connection’s claim is marked ended');
	});

	it('discards the old will of a client that reconnected here, and leaves the new connection’s will alone', async () => {
		const { T, name } = topicTable();
		await crashedConnection(name, 'back', 1);
		const live = await connectWithWill(name, 'back', 2);
		await replayOrphanedWills();
		assert.equal(await T.get('back'), null, 'neither will is published while the client is connected');
		assert.deepStrictEqual(
			(await willRows('back')).map((row) => row.id),
			[['back', live.incarnation]]
		);
		live.disconnect(false);
		await waitFor(async () => (await T.get('back'))?.value === 2, {
			message: 'the new connection’s will is published',
		});
		await waitFor(async () => (await willRows('back')).length === 0, { message: 'its row is deleted' });
		await waitFor(async () => (await claimRows('back')).every((claim) => claim.ended), {
			message: 'both connections’ claims are ended',
		});
	});

	it('discards the old will of a client whose later connection is on a peer', async () => {
		const { T, name } = topicTable();
		const crashed = await crashedConnection(name, 'peer', 1);
		// as replication applies a peer's claim
		await claims().put({
			id: ['peer', 'a-connection-on-a-peer'],
			clientId: 'peer',
			connectedAt: crashed.connectedAt + 1,
		});
		await replayOrphanedWills();
		assert.equal(await T.get('peer'), null);
		assert.deepStrictEqual(await willRows('peer'), []);
	});

	it('publishes the old will when the only other connection of its client began before it', async () => {
		const { T, name } = topicTable();
		const crashed = await crashedConnection(name, 'older-peer', 1);
		await claims().put({
			id: ['older-peer', 'an-earlier-connection'],
			clientId: 'older-peer',
			connectedAt: crashed.connectedAt - 1,
		});
		await replayOrphanedWills();
		assert.strictEqual((await T.get('older-peer'))?.value, 1);
	});

	it('discards the old will of a client that reconnected without a will', async () => {
		const { T, name } = topicTable();
		await crashedConnection(name, 'no-will', 1);
		const live = await getSession({ clientId: 'no-will', user: localPrincipal(), clean: true });
		assert.ok((await claimRows('no-will')).some((claim) => claim.id[1] === live.incarnation));
		await replayOrphanedWills();
		assert.equal(await T.get('no-will'), null);
		assert.deepStrictEqual(await willRows('no-will'), []);
		live.disconnect(false);
		await waitFor(async () => (await claimRows('no-will')).every((claim) => claim.ended), {
			message: 'its claim is ended when it disconnects',
		});
	});

	it('writes no claim for a connection without a will whose client has none', async () => {
		await getSession({ clientId: 'never-willed', user: localPrincipal(), clean: true });
		assert.deepStrictEqual(await claimRows('never-willed'), []);
	});

	it('discards the old will of a client that reconnected and has since disconnected cleanly', async () => {
		const { T, name } = topicTable();
		await crashedConnection(name, 'left', 1);
		const live = await connectWithWill(name, 'left', 2);
		live.disconnect(true);
		await waitFor(async () => (await willRows('left')).length === 1, {
			message: 'the clean DISCONNECT deletes its row',
		});
		await replayOrphanedWills();
		assert.equal(await T.get('left'), null);
		assert.deepStrictEqual(await willRows('left'), []);
	});

	it('never touches a will row the running process wrote', async () => {
		const { T, name } = topicTable();
		const live = await connectWithWill(name, 'live', 1);
		await replayOrphanedWills();
		assert.equal(await T.get('live'), null);
		assert.deepStrictEqual(
			(await willRows('live')).map((row) => row.id),
			[['live', live.incarnation]]
		);
		live.disconnect(false);
		await waitFor(async () => (await T.get('live'))?.value === 1, { message: 'its own disconnect publishes it' });
	});

	it('replays a row written before connections were claimed unless its client has connected since', async () => {
		const { T, name } = topicTable();
		await wills().put({ id: ['legacy', 'old-connection'], ...willFor(name, 'legacy', 1), user: LOCAL_WILL_USER });
		await wills().put({
			id: ['legacy-back', 'old-connection'],
			...willFor(name, 'legacy-back', 2),
			user: LOCAL_WILL_USER,
		});
		const live = await connectWithWill(name, 'legacy-back', 3);
		await replayOrphanedWills();
		assert.strictEqual((await T.get('legacy'))?.value, 1);
		assert.equal(await T.get('legacy-back'), null);
		assert.deepStrictEqual(await willRows('legacy'), []);
		assert.deepStrictEqual(
			(await willRows('legacy-back')).map((row) => row.id),
			[['legacy-back', live.incarnation]]
		);
	});

	it('replays a crashed connection’s will that has no client id', async () => {
		const { T, name } = topicTable();
		await wills().put({
			id: ['', 'anonymous-connection'],
			processIncarnation: PREVIOUS_PROCESS,
			...willFor(name, 'anonymous', 1),
			user: LOCAL_WILL_USER,
		});
		await replayOrphanedWills();
		assert.strictEqual((await T.get('anonymous'))?.value, 1);
		assert.deepStrictEqual(await willRows(''), []);
	});

	it('stops before the next will once shutdown begins', async () => {
		const { T, name } = topicTable();
		await crashedConnection(name, 'first', 1);
		await crashedConnection(name, 'second', 2);
		let checks = 0;
		// one check at the barrier, two while replaying the first will, then the one before the second
		await replayOrphanedWills(() => checks++ > 2);
		assert.strictEqual((await T.get('first'))?.value, 1);
		assert.equal(await T.get('second'), null);
		assert.strictEqual((await willRows('second')).length, 1, 'the row stays for the next boot');
		await replayOrphanedWills();
		assert.strictEqual((await T.get('second'))?.value, 2);
	});

	describe('with cluster peers', () => {
		const peerName = 'will-replay-peer';
		let peerId;
		let nodes;
		before(() => {
			nodes = server.nodes;
			server.nodes = [{ name: peerName }];
			peerId = getIdOfRemoteNode(peerName, claims().auditStore);
			setWillReplayPeerWaitForTests(50, 10_000);
		});
		after(() => {
			server.nodes = nodes;
			setWillReplayPeerWaitForTests();
		});
		afterEach(() => claims().dbisDB.removeSync([SEQ, peerId]));
		const recordPeerFloor = (closedFloor) =>
			claims().dbisDB.putSync([SEQ, peerId], {
				seqId: 1,
				nodes: [{ id: peerId, closedFloor, originGeneration: 'peer-generation', fullCoverage: true, certifiedFrom: 0 }],
			});

		it('replays at once when the peer’s replication carries no floor', async () => {
			const { T, name } = topicTable();
			await crashedConnection(name, 'no-floor', 1);
			await replayOrphanedWills();
			assert.strictEqual((await T.get('no-floor'))?.value, 1);
		});

		it('waits until the peer’s certified floor passes the replay’s start', async () => {
			const { T, name } = topicTable();
			await crashedConnection(name, 'floor', 1);
			recordPeerFloor(Date.now() - 60_000);
			const replay = replayOrphanedWills();
			await sleep(300);
			assert.equal(await T.get('floor'), null, 'held while the peer may hold a later connection this node lacks');
			recordPeerFloor(Date.now() + 1_000);
			await replay;
			assert.strictEqual((await T.get('floor'))?.value, 1);
		});

		it('does not take a floor the peer certified before the wait began as caught up', async () => {
			const { T, name } = topicTable();
			await crashedConnection(name, 'leading-clock', 1);
			// a peer whose clock leads certified this before this node's restart
			const leadingFloor = Date.now() + 30_000;
			recordPeerFloor(leadingFloor);
			const replay = replayOrphanedWills();
			await sleep(300);
			assert.equal(await T.get('leading-clock'), null);
			recordPeerFloor(leadingFloor + 1);
			await replay;
			assert.strictEqual((await T.get('leading-clock'))?.value, 1);
		});

		it('proceeds once a peer has stayed behind for the wait limit', async () => {
			setWillReplayPeerWaitForTests(50, 300);
			try {
				const { T, name } = topicTable();
				await crashedConnection(name, 'unreachable', 1);
				recordPeerFloor(Date.now() - 60_000);
				await replayOrphanedWills();
				assert.strictEqual((await T.get('unreachable'))?.value, 1);
			} finally {
				setWillReplayPeerWaitForTests(50, 10_000);
			}
		});

		it('stops waiting for the peer once shutdown begins, and keeps the rows', async () => {
			const { name } = topicTable();
			await crashedConnection(name, 'floor-stopped', 1);
			recordPeerFloor(Date.now() - 60_000);
			let stopping = false;
			const replay = replayOrphanedWills(() => stopping);
			await sleep(100);
			stopping = true;
			await replay;
			const rows = await willRows('floor-stopped');
			assert.strictEqual(rows.length, 1);
			await wills().delete(rows[0].id);
		});
	});
});
