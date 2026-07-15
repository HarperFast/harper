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

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;
export const FAILOVER_WATCHER_INTERVAL_MS = 75_000;
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
}

type EngineRole = 'inactive' | 'follower' | 'leader';

let engineStarted = false;
let role: EngineRole = 'inactive';
let heartbeatTimer: NodeJS.Timeout | undefined;
let failoverWatcherTimer: NodeJS.Timeout | undefined;
let catchUpRunning = false;
const jobsByComponent = new Map<string, Map<string, RegisteredJob>>();

let _stateTable: any;
function getStateTable() {
	_stateTable ??= table({
		database: 'system',
		table: SCHEDULER_STATE_TABLE,
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
	electRole().catch((error) => {
		schedulerLogger.error?.('Scheduler engine failed to start', error);
	});
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
	_stateTable = undefined;
}

export function getEngineRole(): EngineRole {
	return role;
}

async function electRole(): Promise<void> {
	const self = currentNodeName();
	let leaderRow: any;
	try {
		leaderRow = await getStateTable().get(LEADER_ROW_ID);
	} catch (error) {
		schedulerLogger.warn?.(`Could not read scheduler leader state, proceeding with election: ${error.message}`);
	}
	// Sticky leadership: a node (re)starting while another node is actively
	// leading defers to it rather than seizing leadership back
	if (leaderRow && leaderRow.leaderNode !== self && !isHeartbeatStale(leaderRow.lastHeartbeat)) {
		schedulerLogger.info?.(
			`Scheduler leader is ${leaderRow.leaderNode} (heartbeat fresh); ${self} watching for failover`
		);
		becomeFollower();
		return;
	}
	const roster = nodeRoster();
	if (roster.length <= 1 || pickNextLeader(roster, null) === self) {
		await becomeLeader();
	} else {
		schedulerLogger.info?.(`Scheduler leader election chose ${pickNextLeader(roster, null)}; ${self} is a follower`);
		becomeFollower();
	}
}

async function becomeLeader(): Promise<void> {
	const self = currentNodeName();
	role = 'leader';
	if (failoverWatcherTimer) {
		clearInterval(failoverWatcherTimer);
		failoverWatcherTimer = undefined;
	}
	schedulerLogger.info?.(`Scheduler leader started on ${self}`);
	const now = new Date().toISOString();
	await putStateRow({ id: LEADER_ROW_ID, leaderNode: self, lastHeartbeat: now, initializedAt: now });
	for (const componentName of jobsByComponent.keys()) {
		await scheduleComponentJobs(componentName);
	}
	await runCatchUp();
	heartbeatTimer = setInterval(() => {
		heartbeat().catch((error) => schedulerLogger.error?.('Scheduler heartbeat failed', error));
	}, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref();
}

function becomeFollower(): void {
	role = 'follower';
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
	const self = currentNodeName();
	const leaderRow = await getStateTable().get(LEADER_ROW_ID);
	// Split-brain healing: if another node has taken over with a fresh
	// heartbeat (e.g. we were partitioned long enough to be considered stale),
	// step down instead of dueling over the lease row
	if (leaderRow && leaderRow.leaderNode !== self && !isHeartbeatStale(leaderRow.lastHeartbeat)) {
		schedulerLogger.info?.(`Scheduler leadership was taken over by ${leaderRow.leaderNode}; ${self} stepping down`);
		becomeFollower();
		return;
	}
	await putStateRow({
		id: LEADER_ROW_ID,
		leaderNode: self,
		lastHeartbeat: new Date().toISOString(),
		initializedAt: leaderRow?.initializedAt,
	});
	// Periodic missed-run sweep: catches occurrences lost to DST transitions,
	// worker restarts, and anything else that slipped past the timers
	await runCatchUp();
}

async function failoverCheck(): Promise<void> {
	if (role !== 'follower') return;
	const self = currentNodeName();
	const leaderRow = await getStateTable().get(LEADER_ROW_ID);
	if (leaderRow && !isHeartbeatStale(leaderRow.lastHeartbeat)) return;
	const staleLeader = leaderRow?.leaderNode ?? null;
	const nextLeader = pickNextLeader(nodeRoster(), staleLeader);
	if (nextLeader === self) {
		schedulerLogger.info?.(
			staleLeader
				? `Scheduler leader ${staleLeader} heartbeat is stale; ${self} promoting itself`
				: `No active scheduler leader; ${self} promoting itself`
		);
		await becomeLeader();
	} else {
		schedulerLogger.trace?.(`Scheduler leader is stale but next in line is ${nextLeader}; ${self} keeps watching`);
	}
}

async function putStateRow(row: Record<string, unknown>): Promise<void> {
	try {
		await getStateTable().put(row);
	} catch (error) {
		// State persistence failures must never take the scheduler down; the
		// next heartbeat retries
		schedulerLogger.warn?.(`Failed to persist scheduler state row ${row.id}: ${error.message}`);
	}
}

async function scheduleComponentJobs(componentName: string): Promise<void> {
	const jobMap = jobsByComponent.get(componentName);
	if (!jobMap || role !== 'leader') return;
	for (const job of jobMap.values()) {
		await scheduleNextRun(job);
	}
}

/**
 * Compute the job's next fire time and arm its timer. Interval jobs anchor to
 * their persisted last run so cadence survives restarts and failover; cron
 * jobs fire at the next matching wall-clock time (missed occurrences are
 * handled by the catch-up sweep instead).
 */
async function scheduleNextRun(job: RegisteredJob): Promise<void> {
	if (role !== 'leader' || !jobsByComponent.get(job.componentName)?.has(job.name)) return;
	if (job.timer) clearTimeout(job.timer);
	const now = new Date();
	let fireAt: Date;
	if (job.cron) {
		const next = job.cron.nextDate(now, job.timezone ?? getSystemTimezone());
		if (!next) {
			schedulerLogger.warn?.(`Job ${jobRowId(job)} has no future occurrence; not scheduling`);
			return;
		}
		fireAt = next;
	} else {
		const stateRow = await getJobStateRow(job);
		const lastRun = stateRow?.lastRunAt ? Date.parse(stateRow.lastRunAt) : NaN;
		// An overdue interval (downtime longer than the interval) fires
		// immediately — this is the interval jobs' catch-up path
		fireAt = Number.isNaN(lastRun) ? new Date(now.getTime() + job.intervalMs) : new Date(lastRun + job.intervalMs);
	}
	armTimer(job, fireAt);
}

function armTimer(job: RegisteredJob, fireAt: Date): void {
	const delay = fireAt.getTime() - Date.now();
	if (delay > MAX_TIMEOUT_MS) {
		// Beyond setTimeout's 32-bit range: sleep the maximum and re-arm
		job.timer = setTimeout(() => armTimer(job, fireAt), MAX_TIMEOUT_MS);
	} else {
		job.timer = setTimeout(
			() => {
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
	job.timer.unref();
}

async function getJobStateRow(job: ScheduledJob): Promise<any> {
	try {
		return await getStateTable().get(jobRowId(job));
	} catch (error) {
		schedulerLogger.warn?.(`Failed to read state for job ${jobRowId(job)}: ${error.message}`);
		return undefined;
	}
}

async function executeJob(job: RegisteredJob, scheduledAt: Date, catchUp: boolean): Promise<void> {
	if (role !== 'leader') return;
	if (job.running) {
		// Single-flight: a run that outlasts its own cadence is not stacked
		schedulerLogger.debug?.(`Job ${jobRowId(job)} is still running; skipping this occurrence`);
		return;
	}
	job.running = true;
	const startedAt = new Date();
	const existingRow = await getJobStateRow(job);
	schedulerLogger.trace?.(`Running job ${jobRowId(job)}${catchUp ? ' (catch-up)' : ''}`);
	try {
		await job.handler({ jobName: job.name, scheduledAt, catchUp });
		const durationMs = Date.now() - startedAt.getTime();
		schedulerLogger.trace?.(`Job ${jobRowId(job)} completed in ${durationMs}ms`);
		await putStateRow({
			id: jobRowId(job),
			firstSeenAt: existingRow?.firstSeenAt ?? startedAt.toISOString(),
			lastRunAt: startedAt.toISOString(),
			lastStatus: 'success',
			lastError: undefined,
			lastDurationMs: durationMs,
		});
	} catch (error) {
		const durationMs = Date.now() - startedAt.getTime();
		schedulerLogger.warn?.(`Job ${jobRowId(job)} failed after ${durationMs}ms: ${error.message}`);
		await putStateRow({
			id: jobRowId(job),
			firstSeenAt: existingRow?.firstSeenAt ?? startedAt.toISOString(),
			lastRunAt: startedAt.toISOString(),
			lastStatus: 'error',
			lastError: String(error.message ?? error).slice(0, MAX_STORED_ERROR_LENGTH),
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
	catchUpRunning = true;
	try {
		const now = new Date();
		for (const jobMap of jobsByComponent.values()) {
			for (const job of jobMap.values()) {
				if (!job.cron) continue; // interval jobs self-correct in scheduleNextRun
				try {
					const stateRow = await getJobStateRow(job);
					if (!stateRow?.firstSeenAt) {
						// First time this job is ever seen: record it so future
						// sweeps have a baseline, without firing immediately
						await putStateRow({ id: jobRowId(job), firstSeenAt: now.toISOString() });
						continue;
					}
					const baseline = new Date(Date.parse(stateRow.lastRunAt ?? stateRow.firstSeenAt));
					const missed = findMissedCronOccurrence(job.cron, job.timezone, baseline, now);
					if (missed) {
						schedulerLogger.info?.(
							`Job ${jobRowId(job)} missed its ${missed.toISOString()} occurrence; running catch-up`
						);
						await executeJob(job, missed, true);
					}
				} catch (error) {
					schedulerLogger.warn?.(`Catch-up check failed for job ${jobRowId(job)}: ${error.message}`);
				}
			}
		}
	} finally {
		catchUpRunning = false;
	}
}
