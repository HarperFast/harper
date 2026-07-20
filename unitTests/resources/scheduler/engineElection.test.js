'use strict';

// #1866 — in-repo coverage of the scheduler's election/heartbeat/failover/
// catch-up orchestration (electRole, becomeLeader, heartbeat, failoverCheck,
// runCatchUp, executeJob), which previously had only pure-helper unit tests
// here and true-network validation only in the harper-pro cluster harness.
//
// True multi-node replication is not available in this repo (replication ships
// as a separate component), so this uses the same-process simulated-peer
// pattern (cf. deploy-tracking-peer-branch.test.ts): everything the engine
// knows about other nodes flows through exactly two observables —
// `server.nodes` (normally populated by the replication component) and rows in
// the hdb_scheduler_state table (normally replicated). The test supplies both,
// against the REAL engine module, REAL timers, and a REAL store. Staleness is
// data-driven (a lease heartbeat stamped 10 minutes ago IS a dead leader), so
// no test waits out production thresholds; heartbeat/failover ticks are driven
// through the ForTests seams instead of their intervals.

require('../../testUtils');
const assert = require('node:assert');
const { hostname } = require('node:os');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	registerComponentJobs,
	unregisterComponentJobs,
	startSchedulerEngine,
	stopSchedulerEngine,
	getEngineRole,
	getRegisteredJobNames,
	electionSettledForTests,
	runHeartbeatForTests,
	runFailoverCheckForTests,
	STALE_THRESHOLD_MS,
} = require('#src/resources/scheduler/engine');
const { CronExpression } = require('#src/resources/scheduler/CronExpression');

// server.hostname is a non-configurable getter (nodeName.ts), so instead of
// stubbing the node's identity we read the same expression the engine uses
// and pick peer names that deterministically sort around it: '\u0000' sorts
// before any real hostname, '\uffff' after.
const SELF = global.server.hostname || hostname();
const PEER = '\u0000-peer'; // sorts FIRST, so the peer is the preferred leader
const LAST_PEER = '\uffff-peer'; // sorts LAST, so SELF is preferred
const LEADER_ROW_ID = 'leader';

function isoAgo(ms) {
	return new Date(Date.now() - ms).toISOString();
}

describe('scheduler engine election and failover (simulated peer, #1866)', () => {
	let stateTable;
	let originalNodes;
	// Every handler invocation lands here: [{ jobName, catchUp, scheduledAt }]
	const handlerRuns = [];

	function makeCronJob(name) {
		return {
			name,
			componentName: 'election-test',
			cron: new CronExpression('0 2 * * *'),
			timezone: 'UTC',
			handler: (context) => {
				handlerRuns.push(context);
			},
		};
	}

	before(async () => {
		setMainIsWorker(true);
		// The engine sees peers through server.nodes, normally supplied by the
		// replication component. global.server IS the object engine.ts imports
		// (globals.js + _assignPackageExport), the same stub point the analytics
		// unit tests use for server.nodes.
		originalNodes = global.server.nodes;
		global.server.nodes = [{ name: PEER }];
		// Same table the engine lazily creates; declaring it here too resolves to
		// the same underlying store
		stateTable = table({
			database: 'system',
			table: 'hdb_scheduler_state',
			replicate: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'string', isPrimaryKey: true },
				{ name: 'leaderNode', type: 'string' },
				{ name: 'lastHeartbeat', type: 'string' },
				{ name: 'initializedAt', type: 'string' },
				{ name: 'firstSeenAt', type: 'string' },
				{ name: 'lastRunAt', type: 'string' },
				{ name: 'lastStatus', type: 'string' },
				{ name: 'lastError', type: 'string' },
				{ name: 'lastDurationMs', type: 'number' },
			],
		});
		stopSchedulerEngine();
	});

	after(async () => {
		stopSchedulerEngine();
		global.server.nodes = originalNodes;
		// Leave the shared system table the way we found it
		await stateTable.delete(LEADER_ROW_ID).catch(() => {});
		await stateTable.delete('job:election-test:nightly').catch(() => {});
	});

	// The tests below are deliberately sequential: they walk one node through
	// the full lifecycle — defer to a live peer, take over when it dies (with
	// catch-up), surrender to a takeover, and win a cold-start election.

	it('defers to a peer whose lease heartbeat is fresh (sticky election)', async () => {
		await stateTable.put({
			id: LEADER_ROW_ID,
			leaderNode: PEER,
			lastHeartbeat: isoAgo(1000),
			initializedAt: isoAgo(1000),
		});
		registerComponentJobs('election-test', [makeCronJob('nightly')]);
		startSchedulerEngine();
		await electionSettledForTests();
		assert.strictEqual(getEngineRole(), 'follower', 'a fresh peer lease must win the election');
		assert.strictEqual(handlerRuns.length, 0, 'a follower must not run jobs');
	});

	it('does not promote while the leader keeps beating', async () => {
		await stateTable.put({
			id: LEADER_ROW_ID,
			leaderNode: PEER,
			lastHeartbeat: isoAgo(1000),
			initializedAt: isoAgo(60_000),
		});
		await runFailoverCheckForTests();
		assert.strictEqual(getEngineRole(), 'follower');
		assert.strictEqual(handlerRuns.length, 0);
	});

	it('promotes itself when the leader lease goes stale, and catch-up fires the missed occurrence', async () => {
		// The peer "dies": its last heartbeat is now well past the stale
		// threshold (data-driven — no waiting)
		await stateTable.put({
			id: LEADER_ROW_ID,
			leaderNode: PEER,
			lastHeartbeat: isoAgo(STALE_THRESHOLD_MS * 2),
			initializedAt: isoAgo(STALE_THRESHOLD_MS * 3),
		});
		// The job has run before (two days ago), so its 02:00 UTC occurrence was
		// missed while the old leader was dead — promotion catch-up must fire it
		await stateTable.put({
			id: 'job:election-test:nightly',
			firstSeenAt: isoAgo(48 * 60 * 60 * 1000),
			lastRunAt: isoAgo(48 * 60 * 60 * 1000),
			lastStatus: 'success',
		});
		await runFailoverCheckForTests();
		assert.strictEqual(getEngineRole(), 'leader', 'stale peer lease must yield the leadership');
		assert.strictEqual(handlerRuns.length, 1, 'promotion catch-up must fire exactly one missed occurrence');
		assert.strictEqual(handlerRuns[0].catchUp, true);
		assert.strictEqual(handlerRuns[0].jobName, 'nightly');
		const lease = await stateTable.get(LEADER_ROW_ID);
		assert.strictEqual(lease.leaderNode, SELF, 'the new leader must have claimed the lease row');
	});

	it('renews its own lease on heartbeat', async () => {
		const before = await stateTable.get(LEADER_ROW_ID);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await runHeartbeatForTests();
		const after = await stateTable.get(LEADER_ROW_ID);
		assert.strictEqual(after.leaderNode, SELF);
		assert.ok(
			Date.parse(after.lastHeartbeat) > Date.parse(before.lastHeartbeat),
			'heartbeat must advance the lease timestamp'
		);
	});

	it('steps down when a heartbeat finds another node took the lease (racing write)', async () => {
		// The peer recovered and wrote a FRESH takeover lease between our
		// heartbeats — the committed state a racing write leaves behind, which
		// the takeover check exists to heal (true concurrent-write races are
		// exercised in the harper-pro cluster harness)
		await stateTable.put({
			id: LEADER_ROW_ID,
			leaderNode: PEER,
			lastHeartbeat: new Date().toISOString(),
			initializedAt: new Date().toISOString(),
		});
		const runsBefore = handlerRuns.length;
		await runHeartbeatForTests();
		assert.strictEqual(getEngineRole(), 'follower', 'a fresh competing lease must trigger step-down');
		const lease = await stateTable.get(LEADER_ROW_ID);
		assert.strictEqual(lease.leaderNode, PEER, 'step-down must not overwrite the winner’s lease');
		assert.strictEqual(handlerRuns.length, runsBefore, 'stepping down must not run jobs');
	});

	it('wins a cold-start election when it is the preferred node', async () => {
		stopSchedulerEngine();
		handlerRuns.length = 0;
		await stateTable.delete(LEADER_ROW_ID);
		await stateTable.delete('job:election-test:nightly');
		// Roster where SELF sorts first: it should elect itself immediately
		global.server.nodes = [{ name: LAST_PEER }];
		registerComponentJobs('election-test', [makeCronJob('nightly')]);
		startSchedulerEngine();
		await electionSettledForTests();
		assert.strictEqual(getEngineRole(), 'leader', 'the alphabetically-first node must win a cold start');
		const lease = await stateTable.get(LEADER_ROW_ID);
		assert.strictEqual(lease.leaderNode, SELF);
		// A brand-new job (no prior state row) must NOT fire immediately: the
		// first sweep records firstSeenAt as its baseline instead
		assert.strictEqual(handlerRuns.length, 0, 'a never-run job must not fire on promotion');
		const jobRow = await stateTable.get('job:election-test:nightly');
		assert.ok(jobRow?.firstSeenAt, 'promotion must record the catch-up baseline for a new job');
	});

	it('loses a cold-start election to an alphabetically-preferred roster peer', async () => {
		// No lease row at all: the decision comes ONLY from the roster
		// (server.nodes + self) via nodeRoster()/pickNextLeader — this is the
		// one outcome that cannot pass unless that wiring is correct
		stopSchedulerEngine();
		handlerRuns.length = 0;
		await stateTable.delete(LEADER_ROW_ID);
		await stateTable.delete('job:election-test:nightly');
		global.server.nodes = [{ name: PEER }];
		registerComponentJobs('election-test', [makeCronJob('nightly')]);
		startSchedulerEngine();
		await electionSettledForTests();
		assert.strictEqual(getEngineRole(), 'follower', 'a roster peer that sorts first must win the election');
		assert.strictEqual(handlerRuns.length, 0, 'the election loser must not run jobs');
		const lease = await stateTable.get(LEADER_ROW_ID);
		assert.ok(lease == null, 'the election loser must not claim the lease row');
	});

	it('replaces the job set on re-registration and forgets it on unregister', async () => {
		registerComponentJobs('election-test', [makeCronJob('nightly'), makeCronJob('hourly')]);
		assert.deepStrictEqual(getRegisteredJobNames('election-test').sort(), ['hourly', 'nightly']);
		registerComponentJobs('election-test', [makeCronJob('hourly')]);
		assert.deepStrictEqual(
			getRegisteredJobNames('election-test'),
			['hourly'],
			're-registration must replace, not accumulate'
		);
		unregisterComponentJobs('election-test');
		assert.deepStrictEqual(getRegisteredJobNames('election-test'), [], 'unregister must forget the component');
	});
});
