import { hostname } from 'node:os';
import { table } from '../databases.ts';
import { server } from '../../server/Server.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { CronExpression, getSystemTimezone } from './CronExpression.ts';

const schedulerLogger = harperLogger.forComponent('scheduler');

// One row per scheduled job (run state) plus a singleton leader-lease row.
// Lives in the system database and replicates (auditing enabled) so every node
// sees the current leader's heartbeat and each job's last run — that shared
// view is what makes "fires once per cluster" and failover catch-up work.
const SCHEDULER_STATE_TABLE = 'hdb_scheduler_state';
const LEADER_ROW_ID = 'leader';

// Timing constants are env-overridable (same pattern as liveSubscriptionAuth's
// sweep interval) primarily so multi-node integration tests can exercise
// failover without waiting out the production thresholds
function timingFromEnv(name: string, defaultMs: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : defaultMs;
}
export const HEARTBEAT_INTERVAL_MS = timingFromEnv('HARPER_SCHEDULER_HEARTBEAT_INTERVAL_MS', 60_000);
const rawStaleThreshold = timingFromEnv('HARPER_SCHEDULER_STALE_THRESHOLD_MS', 5 * 60 * 1000);
// A stale threshold at or below the heartbeat interval makes every healthy
// leader look dead (leadership flaps, each promotion re-running catch-up);
// clamp the misconfiguration rather than honor it (audit finding)
export const STALE_THRESHOLD_MS =
	rawStaleThreshold > HEARTBEAT_INTERVAL_MS ? rawStaleThreshold : HEARTBEAT_INTERVAL_MS * 5;
export const FAILOVER_WATCHER_INTERVAL_MS = timingFromEnv('HARPER_SCHEDULER_FAILOVER_WATCHER_INTERVAL_MS', 75_000);
// setTimeout clamps to a 32-bit signed int; longer delays wrap to ~1ms and busy-loop
const MAX_TIMEOUT_MS = 0x7fffffff;
const MAX_STORED_ERROR_LENGTH = 500;

export interface JobRunContext {
	jobName: string;
	// The time this run was scheduled to fire (for catch-up runs, the missed occurrence)
	scheduledAt: Date;
	// True when this run is making up a missed occurrence after downtime or failover
	catchUp: boolean;
}

export interface ScheduledJob {
	name: string;
	componentName: string;
	cron?: CronExpression;
	intervalMs?: number;
	timezone?: string;
	handler: (context: JobRunContext) => unknown;
}

interface RegisteredJob extends ScheduledJob {
	timer?: NodeJS.Timeout;
	running: boolean;
	// In-memory anchor for interval scheduling: survives state-write failures so
	// a frozen persisted lastRunAt cannot time-travel the schedule into a hot
	// loop (review finding: continuous refire under ENOSPC-style write errors)
	lastAttemptAt?: number;
	// In-flight scheduling computation, used to coalesce concurrent
	// scheduleNextRun calls (see scheduleNextRun)
	scheduling?: Promise<void>;
}

type EngineRole = 'inactive' | 'follower' | 'leader';

let engineStarted = false;
let role: EngineRole = 'inactive';
let heartbeatTimer: NodeJS.Timeout | undefined;
let failoverWatcherTimer: NodeJS.Timeout | undefined;
let catchUpRunning = false;
// First time this follower observed the cluster leaderless (no row or stale
// heartbeat); drives the promotion escalation ladder in failoverCheck
let leaderlessSince: number | undefined;
// When this node became leader — fallback for the lease row's initializedAt
// when a heartbeat renews after a failed read
let leaderInitializedAt: string | undefined;
// The in-flight (or settled) election kicked off by startSchedulerEngine —
// held so tests can await the role decision instead of polling
let electionPromise: Promise<void> | undefined;
// Bumped by stopSchedulerEngine: async transitions (electRole, becomeLeader)
// capture it before their awaits and abandon themselves if it moved — an
// in-flight election must not resurrect timers after a stop (review finding)
let engineEpoch = 0;
const jobsByComponent = new Map<string, Map<string, RegisteredJob>>();

let _stateTable: any;
function getStateTable() {
	_stateTable ??= table({
		database: 'system',
		table: SCHEDULER_STATE_TABLE,
		// The cluster-once guarantee depends on every node seeing this table:
		// declare replication POSITIVELY rather than relying on absence from the
		// non-replicating list, so an operator-scoped `replication.databases`
		// config cannot silently exclude it (review finding — that degradation
		// mode is N independent leaders running every job N times)
		replicate: true,
		// Replication of system tables requires auditing
		audit: true,
		attributes: [
			// 'leader' for the lease row; 'job:<component>:<name>' for run state
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
	return _stateTable;
}

function jobRowId(job: ScheduledJob): string {
	return `job:${job.componentName}:${job.name}`;
}

// Every state-table operation is bounded: observed empirically (2-node
// failover) that a read/write issued on a freshly promoted leader — while the
// replication link to the dead peer is still churning — can stall
// indefinitely, wedging the promotion pipeline behind its await while the
// already-started heartbeat keeps renewing the lease. The result was a
// healthy-looking leader running zero jobs, with no error anywhere. A bounded
// operation instead fails into the existing degraded paths (schedule from
// now / skip this sweep / retry next heartbeat).
const STATE_OPERATION_TIMEOUT_MS = 10_000;

function withStateTimeout<T>(operation: Promise<T>, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what} timed out after ${STATE_OPERATION_TIMEOUT_MS}ms`)),
			STATE_OPERATION_TIMEOUT_MS
		);
		timer.unref();
		operation.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * Job handlers and storage drivers can throw anything — including objects
 * whose property getters themselves throw — so even reading .message is
 * guarded here (surfaced by review).
 */
export function safeErrorMessage(error: unknown): string {
	try {
		return (error as any)?.message || String(error);
	} catch {
		try {
			return String(error);
		} catch {
			return 'unknown error';
		}
	}
}

function currentNodeName(): string {
	// server.hostname is the node's replication identity; hostname() is only a
	// local-dev fallback where there is no cluster and the name is just a label
	return (server as any).hostname || hostname();
}

function nodeRoster(): string[] {
	// server.nodes lists PEER nodes only (populated by the replication
	// component); the current node is not included and the list is absent
	// entirely on a single standalone instance
	const peers = ((server as any).nodes || []).map((node: any) => node?.name).filter(Boolean);
	return [...new Set([...peers, currentNodeName()])].sort() as string[];
}

/**
 * Deterministic election: the alphabetically-first node wins, excluding a
 * stale leader so a wedged node cannot immediately re-elect itself. Every node
 * evaluates this identically against the same replicated state, so no
 * consensus round is needed.
 */
export function pickNextLeader(roster: string[], staleLeader: string | null): string | null {
	if (roster.length === 0) return null;
	if (!staleLeader) return roster[0];
	const eligible = roster.filter((name) => name !== staleLeader);
	return eligible.length > 0 ? eligible[0] : roster[0];
}

export function isHeartbeatStale(lastHeartbeat: string | undefined, now: number = Date.now()): boolean {
	if (!lastHeartbeat) return true;
	const heartbeatTime = Date.parse(lastHeartbeat);
	return Number.isNaN(heartbeatTime) || now - heartbeatTime > STALE_THRESHOLD_MS;
}

// Escalation ladder for leaderless promotion: each successive fallback node
// waits this much longer before claiming leadership, giving preferred nodes
// (which check every FAILOVER_WATCHER_INTERVAL_MS) time to claim it first.
export const PROMOTION_ESCALATION_MS = 2 * FAILOVER_WATCHER_INTERVAL_MS;

/**
 * How long this node should observe a leaderless cluster before promoting
 * itself. The preferred (alphabetically-first eligible) node promotes
 * immediately; each subsequent node adds one escalation interval, so a dead or
 * never-started preferred node cannot deadlock the cluster — the next node in
 * line claims leadership one rung later, and sticky leadership plus the
 * heartbeat takeover check heal any race between rungs.
 */
export function promotionWaitMs(roster: string[], self: string, staleLeader: string | null): number {
	const eligible = staleLeader ? roster.filter((name) => name !== staleLeader) : roster;
	const queue = eligible.length > 0 ? eligible : roster;
	const queueIndex = queue.indexOf(self);
	// A node not in the queue (it IS the stale leader) goes to the back
	const rung = queueIndex < 0 ? queue.length : queueIndex;
	return rung * PROMOTION_ESCALATION_MS;
}

/**
 * The cron occurrence that should have fired but didn't, or null if the job is
 * up to date. `baseline` is the job's last run (or when it was first seen, so
 * a newly-deployed job waits for its first scheduled time instead of firing
 * immediately).
 */
export function findMissedCronOccurrence(
	cron: CronExpression,
	timezone: string | undefined,
	baseline: Date,
	now: Date
): Date | null {
	const previousOccurrence = cron.previousDate(now, timezone ?? getSystemTimezone());
	if (previousOccurrence && previousOccurrence.getTime() > baseline.getTime()) return previousOccurrence;
	return null;
}

/**
 * Register (or replace) the scheduled jobs for a component. Called from the
 * scheduler plugin's handleApplication on the scheduling worker; safe to call
 * repeatedly — a reload or redeploy replaces the component's whole job set.
 */
export function registerComponentJobs(componentName: string, jobs: ScheduledJob[]): void {
	unregisterComponentJobs(componentName);
	const jobMap = new Map<string, RegisteredJob>();
	for (const job of jobs) {
		jobMap.set(job.name, { ...job, running: false });
	}
	jobsByComponent.set(componentName, jobMap);
	if (role === 'leader') {
		// Fire-and-forget: scheduling reads run state from the DB and must not
		// block handleApplication (which holds a cross-thread load lock)
		scheduleComponentJobs(componentName).catch((error) => {
			schedulerLogger.error?.(`Failed to schedule jobs for ${componentName}`, error);
		});
	}
}

/**
 * Cancel timers and forget the jobs of a component (its scope is closing —
 * worker shutdown, redeploy, or a discarded deploy-validation load).
 *
 * Leadership is deliberately retained even if this empties the job set: the
 * common cause is a reload that re-registers moments later, and stepping down
 * here would leave the engine unable to re-elect (startSchedulerEngine is
 * one-shot per worker). An idle leader heartbeating a zero-job cluster is
 * harmless and resolves on the next worker restart.
 */
export function unregisterComponentJobs(componentName: string): void {
	const jobMap = jobsByComponent.get(componentName);
	if (!jobMap) return;
	for (const job of jobMap.values()) {
		if (job.timer) clearTimeout(job.timer);
	}
	jobsByComponent.delete(componentName);
}

/**
 * Start the engine's cluster role (leader or follower). Idempotent; called
 * once per scheduling worker regardless of how many components declare jobs.
 * All the real work happens asynchronously so the caller (handleApplication,
 * which holds a cross-thread load lock with a 30s timeout) returns fast.
 */
export function startSchedulerEngine(): void {
	if (engineStarted) return;
	engineStarted = true;
	electionPromise = electRole().catch((error) => {
		schedulerLogger.error?.('Scheduler engine failed to start', error);
	});
}

/** @internal — testing only: resolves when the initial election has settled */
export function electionSettledForTests(): Promise<void> {
	return electionPromise ?? Promise.resolve();
}

/**
 * @internal — testing only: run one heartbeat tick immediately (same body the
 * interval runs), so tests can drive lease renewal / takeover checks without
 * waiting out HEARTBEAT_INTERVAL_MS. Same seam pattern as
 * setCoolingFunctionForTests in transactionLogCooling.
 */
export function runHeartbeatForTests(): Promise<void> {
	return heartbeat();
}

/** @internal — testing only: run one failover-watcher tick immediately */
export function runFailoverCheckForTests(): Promise<void> {
	return failoverCheck();
}

/** Reset all engine state and timers. Intended for tests. */
export function stopSchedulerEngine(): void {
	for (const componentName of [...jobsByComponent.keys()]) {
		unregisterComponentJobs(componentName);
	}
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	if (failoverWatcherTimer) clearInterval(failoverWatcherTimer);
	heartbeatTimer = undefined;
	failoverWatcherTimer = undefined;
	role = 'inactive';
	engineStarted = false;
	catchUpRunning = false;
	leaderlessSince = undefined;
	leaderInitializedAt = undefined;
	electionPromise = undefined;
	engineEpoch++;
	_stateTable = undefined;
}

export function getEngineRole(): EngineRole {
	return role;
}

/** @internal — testing only */
export function getRegisteredJobNames(componentName: string): string[] {
	return [...(jobsByComponent.get(componentName)?.keys() ?? [])];
}

async function electRole(): Promise<void> {
	const self = currentNodeName();
	const epoch = engineEpoch;
	let leaderRow: any;
	try {
		leaderRow = await withStateTimeout(getStateTable().get(LEADER_ROW_ID), 'leader state read');
	} catch (error) {
		if (epoch !== engineEpoch) return; // stopped while electing
		// Fail toward followership: electing ourselves while the state table is
		// unreadable risks a second leader. The failover watcher keeps checking
		// and promotes once reads succeed and show a leaderless cluster.
		schedulerLogger.warn?.(`Could not read scheduler leader state, defaulting to follower: ${safeErrorMessage(error)}`);
		becomeFollower();
		return;
	}
	if (epoch !== engineEpoch) return; // stopped while electing
	// Sticky leadership: a node (re)starting while another node is actively
	// leading defers to it rather than seizing leadership back
	if (leaderRow && leaderRow.leaderNode !== self && !isHeartbeatStale(leaderRow.lastHeartbeat)) {
		schedulerLogger.info?.(
			`Scheduler leader is ${leaderRow.leaderNode} (heartbeat fresh); ${self} watching for failover`
		);
		becomeFollower();
		return;
	}
	// A fresh lease naming THIS node means a prior same-node incarnation was
	// just leading (overlapping worker restart) — skip the promotion catch-up
	// so its still-committing runs are not immediately re-fired
	const previousIncarnationActive =
		leaderRow != null && leaderRow.leaderNode === self && !isHeartbeatStale(leaderRow.lastHeartbeat);
	const roster = nodeRoster();
	if (roster.length <= 1 || pickNextLeader(roster, null) === self) {
		await becomeLeader(previousIncarnationActive);
	} else {
		schedulerLogger.info?.(`Scheduler leader election chose ${pickNextLeader(roster, null)}; ${self} is a follower`);
		becomeFollower();
	}
}

async function becomeLeader(skipInitialCatchUp = false): Promise<void> {
	const self = currentNodeName();
	const epoch = engineEpoch;
	role = 'leader';
	if (failoverWatcherTimer) {
		clearInterval(failoverWatcherTimer);
		failoverWatcherTimer = undefined;
	}
	// A second promotion (e.g. two failover checks in flight) must not orphan
	// the first heartbeat interval — an orphaned heartbeat would keep renewing
	// the lease after step-down with no timers armed, silently stopping all
	// jobs cluster-wide (audit finding)
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	}
	schedulerLogger.info?.(`Scheduler leader started on ${self}`);
	if (getStateTable().replicate === false) {
		// The cluster-once guarantee is void if this table stops replicating;
		// fail loudly instead of silently multiplying job executions
		schedulerLogger.error?.(
			`${SCHEDULER_STATE_TABLE} is not replicating — scheduled jobs may run on every node instead of once per cluster`
		);
	}
	const now = new Date().toISOString();
	leaderInitializedAt = now;
	await putStateRow({ id: LEADER_ROW_ID, leaderNode: self, lastHeartbeat: now, initializedAt: now });
	// A stop while the lease write was in flight must not resurrect the
	// heartbeat interval (review finding: in-flight transitions surviving
	// stopSchedulerEngine)
	if (epoch !== engineEpoch) return;
	// The heartbeat interval must be beating BEFORE the promotion catch-up
	// pass: catch-up runs user handlers serially and can exceed the stale
	// threshold, and a leader that stops renewing mid-catch-up looks dead —
	// the next follower would promote and re-run the same occurrences
	// (review finding). runCatchUp is single-flight, so the first heartbeat
	// tick overlapping the promotion pass skips its own sweep.
	heartbeatTimer = setInterval(() => {
		heartbeat().catch((error) => schedulerLogger.error?.('Scheduler heartbeat failed', error));
	}, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref();
	for (const componentName of jobsByComponent.keys()) {
		await scheduleComponentJobs(componentName);
	}
	// Skipped when a prior same-node incarnation was just leading (overlapping
	// worker restart): its runs may still be committing, and an immediate
	// catch-up pass would re-fire the occurrence it is mid-executing. The
	// heartbeat sweep still catches genuinely missed occurrences within 60s.
	if (!skipInitialCatchUp) await runCatchUp();
}

function becomeFollower(): void {
	role = 'follower';
	leaderlessSince = undefined;
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	}
	for (const jobMap of jobsByComponent.values()) {
		for (const job of jobMap.values()) {
			if (job.timer) {
				clearTimeout(job.timer);
				job.timer = undefined;
			}
		}
	}
	if (failoverWatcherTimer) return;
	failoverWatcherTimer = setInterval(() => {
		failoverCheck().catch((error) => schedulerLogger.error?.('Scheduler failover check failed', error));
	}, FAILOVER_WATCHER_INTERVAL_MS);
	failoverWatcherTimer.unref();
}

async function heartbeat(): Promise<void> {
	// A tick from a stale interval (already stepped down / re-promoted) must
	// not renew the lease
	if (role !== 'leader') return;
	const self = currentNodeName();
	let leaderRow: any;
	try {
		leaderRow = await withStateTimeout(getStateTable().get(LEADER_ROW_ID), 'leader state read');
	} catch (error) {
		// A failed read must NOT abort the tick: skipping renewal makes a live
		// leader look stale (a follower would promote and dual-execute), and
		// skipping the takeover check breaks the path that heals dual
		// leadership. Renew blind; the step-down check runs on the next tick.
		schedulerLogger.warn?.(`Failed to read leader state during heartbeat: ${safeErrorMessage(error)}`);
	}
	// Split-brain healing: if another node has taken over with a fresh
	// heartbeat (e.g. we were partitioned long enough to be considered stale),
	// step down instead of dueling over the lease row
	if (leaderRow != null && leaderRow.leaderNode !== self && !isHeartbeatStale(leaderRow.lastHeartbeat)) {
		schedulerLogger.info?.(`Scheduler leadership was taken over by ${leaderRow.leaderNode}; ${self} stepping down`);
		becomeFollower();
		return;
	}
	await putStateRow({
		id: LEADER_ROW_ID,
		leaderNode: self,
		lastHeartbeat: new Date().toISOString(),
		initializedAt: leaderRow?.initializedAt ?? leaderInitializedAt,
	});
	// Periodic missed-run sweep: catches occurrences lost to DST transitions,
	// worker restarts, and anything else that slipped past the timers
	await runCatchUp();
}

async function failoverCheck(): Promise<void> {
	if (role !== 'follower') return;
	const self = currentNodeName();
	const epoch = engineEpoch;
	let leaderRow: any;
	try {
		leaderRow = await withStateTimeout(getStateTable().get(LEADER_ROW_ID), 'leader state read');
	} catch (error) {
		// Can't tell whether a leader exists; skip this tick (and don't let the
		// leaderless clock run) rather than risk promoting into a split brain
		schedulerLogger.warn?.(`Failed to read leader state during failover check: ${safeErrorMessage(error)}`);
		leaderlessSince = undefined;
		return;
	}
	if (leaderRow != null && !isHeartbeatStale(leaderRow.lastHeartbeat)) {
		leaderlessSince = undefined;
		return;
	}
	// Re-check after the await: a concurrent (stalled) check may have promoted
	// this node already (audit finding), or the engine may have been stopped
	// while the read was in flight (review finding) — either way, do not promote
	if (role !== 'follower' || epoch !== engineEpoch) return;
	const now = Date.now();
	leaderlessSince ??= now;
	const roster = nodeRoster();
	const staleLeader = leaderRow?.leaderNode ?? null;
	const waitMs = promotionWaitMs(roster, self, staleLeader);
	if (now - leaderlessSince >= waitMs) {
		schedulerLogger.info?.(
			staleLeader
				? `Scheduler leader ${staleLeader} heartbeat is stale; ${self} promoting itself`
				: `No active scheduler leader; ${self} promoting itself`
		);
		leaderlessSince = undefined;
		await becomeLeader();
	} else {
		schedulerLogger.trace?.(
			`Scheduler leader is stale or absent; ${self} promotes in ${Math.round((waitMs - (now - leaderlessSince)) / 1000)}s unless a preferred node claims leadership`
		);
	}
}

async function putStateRow(row: Record<string, unknown>): Promise<void> {
	try {
		await withStateTimeout(getStateTable().put(row), `state write ${row.id}`);
	} catch (error) {
		// State persistence failures must never take the scheduler down; the
		// next heartbeat retries
		schedulerLogger.warn?.(`Failed to persist scheduler state row ${row.id}: ${safeErrorMessage(error)}`);
	}
}

async function scheduleComponentJobs(componentName: string): Promise<void> {
	const jobMap = jobsByComponent.get(componentName);
	if (!jobMap || role !== 'leader') return;
	for (const job of jobMap.values()) {
		await scheduleNextRun(job);
	}
}

// A job is live only while it is the EXACT object the registry holds:
// registerComponentJobs replaces objects under the same names, so a name-only
// check would let an in-flight chain re-arm a replaced job forever (review
// finding: persistent double-fire after redeploy-during-run)
function isRegistered(job: RegisteredJob): boolean {
	return jobsByComponent.get(job.componentName)?.get(job.name) === job;
}

/**
 * Compute the job's next fire time and arm its timer. Interval jobs anchor to
 * their persisted last run so cadence survives restarts and failover; cron
 * jobs fire at the next matching wall-clock time (missed occurrences are
 * handled by the catch-up sweep instead).
 *
 * Concurrent calls for the same job coalesce onto one computation: the
 * callers (becomeLeader's initial loop, a registration's fire-and-forget, a
 * post-run reschedule, the heartbeat sweep) can otherwise interleave across
 * the state read below, each pass the no-timer check, and each arm a timer —
 * with only the last handle retained, leaving an uncancellable live timer
 * (review finding).
 */
function scheduleNextRun(job: RegisteredJob): Promise<void> {
	job.scheduling ??= computeAndArmNextRun(job).finally(() => {
		job.scheduling = undefined;
	});
	return job.scheduling;
}

async function computeAndArmNextRun(job: RegisteredJob): Promise<void> {
	if (role !== 'leader' || !isRegistered(job)) return;
	if (job.timer) clearTimeout(job.timer);
	const now = new Date();
	let fireAt: Date;
	if (job.cron) {
		const next = job.cron.nextDate(now, job.timezone ?? getSystemTimezone());
		if (!next) {
			// Transient (e.g. a DST-window computation edge): the catch-up sweep
			// re-arms unarmed cron jobs every heartbeat, so this self-heals
			schedulerLogger.warn?.(`Job ${jobRowId(job)} has no computable next occurrence; retrying at next heartbeat`);
			return;
		}
		fireAt = next;
	} else {
		const stateRow = await getJobStateRow(job);
		const persistedLastRun = stateRow?.lastRunAt ? Date.parse(stateRow.lastRunAt) : NaN;
		// Anchor to the LATEST of the persisted run and the in-memory attempt:
		// the persisted value survives restarts/failover (overdue intervals fire
		// immediately — the interval catch-up path), while the in-memory value
		// survives state-WRITE failures so a frozen persisted row cannot cause
		// an immediate-refire hot loop (review finding). Clamped to now: a
		// FUTURE timestamp from a clock-skewed leader must not wedge the job
		// (audit finding).
		const anchor = Math.min(
			Math.max(Number.isNaN(persistedLastRun) ? 0 : persistedLastRun, job.lastAttemptAt ?? 0),
			now.getTime()
		);
		fireAt = anchor > 0 ? new Date(anchor + job.intervalMs) : new Date(now.getTime() + job.intervalMs);
	}
	// Re-check after the await: the registry (or our role) may have changed
	// while reading job state, and arming a timer for a stale object leaks a
	// timer nothing can cancel
	if (role !== 'leader' || !isRegistered(job)) return;
	armTimer(job, fireAt);
}

function armTimer(job: RegisteredJob, fireAt: Date): void {
	const delay = fireAt.getTime() - Date.now();
	// Fail closed on a non-finite target: setTimeout coerces NaN to ~1ms,
	// which would hot-loop the job (review finding). Cron jobs re-arm via the
	// heartbeat sweep; interval bounds are validated at config load.
	if (!Number.isFinite(delay)) {
		schedulerLogger.error?.(`Job ${jobRowId(job)} computed a non-finite fire time; not arming`);
		return;
	}
	if (delay > MAX_TIMEOUT_MS) {
		// Beyond setTimeout's 32-bit range: sleep the maximum and re-arm
		job.timer = setTimeout(() => {
			job.timer = undefined;
			if (role === 'leader' && isRegistered(job)) armTimer(job, fireAt);
		}, MAX_TIMEOUT_MS);
	} else {
		job.timer = setTimeout(
			() => {
				// Cleared at fire time so "unarmed" is observable: the heartbeat
				// catch-up sweep re-arms cron jobs whose timer is missing
				job.timer = undefined;
				executeJob(job, fireAt, false)
					.catch((error) => schedulerLogger.error?.(`Job ${jobRowId(job)} execution failed unexpectedly`, error))
					.finally(() => {
						scheduleNextRun(job).catch((error) =>
							schedulerLogger.error?.(`Failed to reschedule job ${jobRowId(job)}`, error)
						);
					});
			},
			Math.max(delay, 0)
		);
	}
	job.timer?.unref();
}

// The persisted error replicates cluster-wide; strip filesystem paths (which
// leak node-local layout) and bound the length
export function sanitizeStoredError(message: string): string {
	return message
		.replace(/\/(?:Users|home|var|tmp|opt|etc|root|srv|data|mnt)\/[^\s:)]+/g, '[path]')
		.replace(/[A-Za-z]:\\[^\s:)]+/g, '[path]')
		.slice(0, MAX_STORED_ERROR_LENGTH);
}

// Swallow-to-undefined is deliberate for the timer-arming path (an unreadable
// row degrades to "schedule from now"); the catch-up sweep must NOT use this —
// it needs to distinguish "row absent" from "read failed", because treating a
// transient read error as "job never seen" previously triggered a destructive
// first-seen overwrite of the whole run-state row (audit finding)
async function getJobStateRow(job: ScheduledJob): Promise<any> {
	try {
		return await withStateTimeout(getStateTable().get(jobRowId(job)), `job state read ${jobRowId(job)}`);
	} catch (error) {
		schedulerLogger.warn?.(`Failed to read state for job ${jobRowId(job)}: ${safeErrorMessage(error)}`);
		return undefined;
	}
}

async function executeJob(job: RegisteredJob, scheduledAt: Date, catchUp: boolean): Promise<void> {
	// The registration re-check matters as much as the role check: a timer can
	// fire after its component's scope closed or after a reload replaced the
	// job object, and a discarded component's handler must not run against
	// production state (review finding)
	if (role !== 'leader' || !isRegistered(job)) return;
	// In-memory dedup for catch-up: the sweep decides from a state snapshot
	// that can predate a run which started (or finished) while the snapshot
	// read was in flight; lastAttemptAt is set synchronously at run start on
	// this thread, so it cannot be stale (audit finding)
	if (catchUp && job.lastAttemptAt !== undefined && job.lastAttemptAt >= scheduledAt.getTime()) {
		return;
	}
	if (job.running) {
		// Single-flight: a run that outlasts its own cadence is not stacked
		schedulerLogger.debug?.(`Job ${jobRowId(job)} is still running; skipping this occurrence`);
		return;
	}
	job.running = true;
	const startedAt = new Date();
	// The attempt anchor and persisted lastRunAt cover the occurrence, not
	// just the wall clock: if a clock step-back lands the run before its own
	// fireAt, recording the bare start time would make the next sweep
	// re-deliver the occurrence (audit finding). Catch-up runs (scheduledAt in
	// the past) keep startedAt. Set synchronously, before any await.
	job.lastAttemptAt = Math.max(startedAt.getTime(), scheduledAt.getTime());
	const lastRunAt = new Date(job.lastAttemptAt).toISOString();
	const existingRow = await getJobStateRow(job);
	schedulerLogger.trace?.(`Running job ${jobRowId(job)}${catchUp ? ' (catch-up)' : ''}`);
	try {
		await job.handler({ jobName: job.name, scheduledAt, catchUp });
		const durationMs = Date.now() - startedAt.getTime();
		schedulerLogger.trace?.(`Job ${jobRowId(job)} completed in ${durationMs}ms`);
		await putStateRow({
			id: jobRowId(job),
			firstSeenAt: existingRow?.firstSeenAt ?? startedAt.toISOString(),
			lastRunAt,
			lastStatus: 'success',
			lastError: undefined,
			lastDurationMs: durationMs,
		});
	} catch (error) {
		const durationMs = Date.now() - startedAt.getTime();
		const errorMessage = safeErrorMessage(error);
		schedulerLogger.warn?.(`Job ${jobRowId(job)} failed after ${durationMs}ms: ${errorMessage}`);
		await putStateRow({
			id: jobRowId(job),
			firstSeenAt: existingRow?.firstSeenAt ?? startedAt.toISOString(),
			lastRunAt,
			lastStatus: 'error',
			lastError: sanitizeStoredError(errorMessage),
			lastDurationMs: durationMs,
		});
	} finally {
		job.running = false;
	}
}

/**
 * Fire one catch-up run for every cron job whose most recent occurrence was
 * missed (leader was down, worker restarted, DST skipped the slot, …). Runs on
 * promotion and on every heartbeat; single-flight so a slow catch-up pass
 * never overlaps the next one.
 */
async function runCatchUp(): Promise<void> {
	if (catchUpRunning || role !== 'leader') return;
	// TODO(#951): reap orphaned job:<component>:<name> rows whose job no longer
	// exists in any registered component, so renamed/removed jobs don't
	// accumulate state rows forever
	catchUpRunning = true;
	try {
		const now = new Date();
		// Snapshot: each await below yields, and a component reload can mutate
		// jobsByComponent mid-sweep (surfaced by review)
		const cronJobs: RegisteredJob[] = [];
		for (const jobMap of jobsByComponent.values()) {
			for (const job of jobMap.values()) {
				if (job.cron) cronJobs.push(job); // interval jobs self-correct in scheduleNextRun
			}
		}
		for (const job of cronJobs) {
			// A job unregistered (or replaced) while the sweep was underway must
			// not fire
			if (!isRegistered(job)) continue;
			try {
				// Unlike the timer-arming path, a read failure here must THROW
				// (the per-job catch below logs and skips) — conflating it with
				// "row absent" fed the destructive re-seed below (audit finding)
				const stateRow = await withStateTimeout<any>(
					getStateTable().get(jobRowId(job)),
					`job state read ${jobRowId(job)}`
				);
				// Baseline = the newest of the persisted timestamps and the
				// in-memory attempt anchor. Including lastAttemptAt closes two
				// duplicate-execution paths the persisted row alone cannot: a
				// sustained state-WRITE outage freezing lastRunAt (the sweep
				// would re-fire a completed occurrence every heartbeat), and a
				// fast run completing while this sweep's read was in flight.
				// Clamped to now so a clock-skewed future timestamp cannot
				// suppress catch-up (audit findings).
				const parsedBaseline = Math.max(
					Date.parse(stateRow?.lastRunAt ?? '') || 0,
					Date.parse(stateRow?.firstSeenAt ?? '') || 0,
					job.lastAttemptAt ?? 0
				);
				if (parsedBaseline === 0) {
					// Row absent, or timestamps missing/unparseable: (re)seed the
					// baseline without firing. put is full-record replacement, so
					// preserve whatever fields exist, and skip while a run is in
					// flight so the seed cannot clobber its just-committed result
					if (!job.running) {
						await putStateRow({
							id: jobRowId(job),
							firstSeenAt: now.toISOString(),
							lastRunAt: stateRow?.lastRunAt,
							lastStatus: stateRow?.lastStatus,
							lastError: stateRow?.lastError,
							lastDurationMs: stateRow?.lastDurationMs,
						});
					}
				} else {
					const baseline = new Date(Math.min(parsedBaseline, now.getTime()));
					const missed = findMissedCronOccurrence(job.cron, job.timezone, baseline, now);
					if (missed) {
						schedulerLogger.info?.(
							`Job ${jobRowId(job)} missed its ${missed.toISOString()} occurrence; running catch-up`
						);
						await executeJob(job, missed, true);
					}
				}
				// Self-heal: a cron job left unarmed (nextDate returned null during
				// a DST window, or a reschedule failed) gets its timer re-armed here
				// every heartbeat instead of staying degraded until failover
				if (!job.running && !job.timer && isRegistered(job)) {
					await scheduleNextRun(job);
				}
			} catch (error) {
				schedulerLogger.warn?.(`Catch-up check failed for job ${jobRowId(job)}: ${safeErrorMessage(error)}`);
			}
		}
	} finally {
		catchUpRunning = false;
	}
}
