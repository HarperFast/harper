import { isAbsolute, join } from 'node:path';
import { getWorkerIndex } from '../../server/threads/manageThreads.js';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { convertToMS } from '../../utility/common_utils.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { CronExpression, validateTimezone } from './CronExpression.ts';
import {
	registerComponentJobs,
	safeErrorMessage,
	startSchedulerEngine,
	unregisterComponentJobs,
	type JobRunContext,
	type ScheduledJob,
} from './engine.ts';

const schedulerLogger = harperLogger.forComponent('scheduler');

export class SchedulerConfigError extends ClientError {
	constructor(message: string) {
		super(message, 400);
		this.name = 'SchedulerConfigError';
	}
}

const MIN_INTERVAL_MS = 1000;
// Generous for any real maintenance cadence while keeping fire-time
// arithmetic comfortably inside Date range
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
const KNOWN_JOB_KEYS = new Set(['name', 'cron', 'interval', 'timezone', 'handler']);

interface SchedulerJobConfig {
	name?: unknown;
	cron?: unknown;
	interval?: unknown;
	timezone?: unknown;
	handler?: unknown;
}

/**
 * Built-in `scheduler` plugin (issue #951): lets a component declare recurring
 * jobs in its config and have core invoke a designated export on that
 * schedule, exactly once per cluster (leader election and failover live in
 * ./engine.ts).
 *
 * ```yaml
 * scheduler:
 *   jobs:
 *     - name: daily-metrics-snapshot
 *       cron: '0 2 * * *'
 *       timezone: America/New_York   # optional; defaults to the server timezone
 *       handler: ./jobs.ts#snapshotMetrics
 *     - name: sync-exchange-rates
 *       interval: 15m                # simple cadence instead of cron
 *       handler: ./jobs.ts#syncExchangeRates
 * ```
 *
 * The handler reference is `<module path>#<named export>` relative to the
 * component directory (omit `#...` to use the module's default export). The
 * handler is invoked with a {@link JobRunContext} and may return a promise.
 *
 * Handlers should be idempotent: leadership failover (the lease has no
 * compare-and-set) and DST fall-back can occasionally deliver the same logical
 * occurrence twice. Conversely, catch-up only makes up the single most recent
 * missed occurrence of a cron job — a leader down for an extended outage does
 * not backfill every occurrence it missed.
 */
export async function handleApplication(scope): Promise<void> {
	// Validation runs UNCONDITIONALLY — on every worker and on deploy
	// pre-flight validation loads, which land on an arbitrary worker. Gating
	// validation behind worker 0 would let a bad config pass pre-flight
	// nondeterministically and then fail cluster-wide at the next restart
	// (review finding). Only ACTIVATION is gated below.
	const config = scope.options.getAll() ?? {};
	// null covers the common "all jobs commented out" edit, which YAML parses
	// as `jobs: null` — that must degrade like an absent key, not fail the
	// whole component load (audit finding)
	if (config.jobs == null) {
		schedulerLogger.warn?.(`Component ${scope.appName} has a scheduler block with no jobs`);
		return;
	}
	if (!Array.isArray(config.jobs)) {
		throw new SchedulerConfigError(`scheduler.jobs in component ${scope.appName} must be an array of job entries`);
	}

	const jobs: ScheduledJob[] = [];
	const seenNames = new Set<string>();
	for (const jobConfig of config.jobs as SchedulerJobConfig[]) {
		const job = await buildJob(scope, jobConfig);
		if (seenNames.has(job.name)) {
			throw new SchedulerConfigError(`Duplicate scheduler job name "${job.name}" in component ${scope.appName}`);
		}
		seenNames.add(job.name);
		jobs.push(job);
	}

	// Activation gates: one worker owns scheduling for the whole node
	// (getWorkerIndex() === 0 is correct in every threading mode, including
	// threads:0 where the main thread acts as worker 0), and a deploy
	// pre-flight validation scope must never touch the live engine — it can
	// share a running component's identity, so registering from it would
	// displace the real component's jobs (review finding).
	if (getWorkerIndex() !== 0) {
		schedulerLogger.debug?.('Scheduler config validated; activation skipped on non-primary worker');
		return;
	}
	if (scope.isTransientValidation) {
		schedulerLogger.debug?.(`Scheduler config validated for ${scope.appName}; activation skipped for validation load`);
		return;
	}

	registerComponentJobs(scope.appName, jobs);
	// A closing scope (worker shutdown or redeploy) must take its timers with it
	scope.on('close', () => unregisterComponentJobs(scope.appName));
	// Scope only requests a restart on option CHANGES; deleting the whole
	// scheduler: block emits 'remove', which nothing else consumes — without
	// this, a dev-watch session keeps firing jobs whose config is gone
	// (audit finding)
	scope.options.on('remove', () => scope.requestRestart());
	startSchedulerEngine();
	schedulerLogger.trace?.(`Registered ${jobs.length} scheduled job(s) for component ${scope.appName}`);
}

async function buildJob(scope, jobConfig: SchedulerJobConfig): Promise<ScheduledJob> {
	const componentName = scope.appName;
	if (typeof jobConfig !== 'object' || jobConfig === null) {
		throw new SchedulerConfigError(`Each scheduler.jobs entry in component ${componentName} must be an object`);
	}
	const { name, cron, interval, timezone, handler } = jobConfig;
	// The schema declares additionalProperties: false but is IDE-only; without
	// this runtime check a misspelled OPTIONAL key (timeZone:, timzone:) is
	// silently dropped and the job runs with different behavior — e.g. a cron
	// evaluated in the server timezone instead of the intended one
	// (audit finding)
	const unknownKeys = Object.keys(jobConfig).filter((key) => !KNOWN_JOB_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new SchedulerConfigError(
			`Scheduler job entry in component ${componentName} has unrecognized key(s): ${unknownKeys.join(', ')} (allowed: name, cron, interval, timezone, handler)`
		);
	}
	if (typeof name !== 'string' || name.length === 0) {
		throw new SchedulerConfigError(`Every scheduler job in component ${componentName} needs a non-empty string name`);
	}
	if ((cron === undefined) === (interval === undefined)) {
		throw new SchedulerConfigError(
			`Scheduler job "${name}" in component ${componentName} must declare exactly one of "cron" or "interval"`
		);
	}
	if (typeof handler !== 'string' || handler.length === 0) {
		throw new SchedulerConfigError(
			`Scheduler job "${name}" in component ${componentName} needs a handler like "./jobs.ts#myExport"`
		);
	}

	const job: ScheduledJob = {
		name,
		componentName,
		handler: await resolveHandler(scope, name, handler),
	};
	if (cron !== undefined) {
		if (typeof cron !== 'string') {
			throw new SchedulerConfigError(`Scheduler job "${name}" in component ${componentName}: "cron" must be a string`);
		}
		job.cron = new CronExpression(cron);
		if (timezone !== undefined) {
			if (typeof timezone !== 'string') {
				throw new SchedulerConfigError(
					`Scheduler job "${name}" in component ${componentName}: "timezone" must be an IANA timezone string`
				);
			}
			job.timezone = validateTimezone(timezone);
		}
	} else {
		if (timezone !== undefined) {
			throw new SchedulerConfigError(
				`Scheduler job "${name}" in component ${componentName}: "timezone" only applies to cron schedules`
			);
		}
		// convertToMS silently treats any unrecognized unit as seconds (e.g.
		// '500ms' would become 500 seconds); restrict to the documented forms
		if (typeof interval === 'string' && !/^\d+(\.\d+)?[smhd]?$/.test(interval.trim())) {
			throw new SchedulerConfigError(
				`Scheduler job "${name}" in component ${componentName}: interval "${interval}" is not a supported duration — use a number of seconds or a value like 90s, 5m, 1h, 1d`
			);
		}
		const intervalMs = convertToMS(typeof interval === 'string' ? interval.trim() : interval);
		// Both bounds matter: values that overflow Date arithmetic (YAML .inf,
		// 1e309, or absurdly large finite numbers) would otherwise produce an
		// Invalid Date downstream, whose NaN delay Node's setTimeout coerces to
		// ~1ms — turning a "practically never" interval into a hot loop
		// (review finding)
		if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
			throw new SchedulerConfigError(
				`Scheduler job "${name}" in component ${componentName}: interval "${interval}" must be between 1 second and 365 days (e.g. 90s, 5m, 1h, 1d)`
			);
		}
		job.intervalMs = intervalMs;
	}
	return job;
}

/**
 * Resolve a `<module path>#<named export>` handler reference to a callable,
 * loading the module inside the component's own realm via scope.import so the
 * handler sees the same globals (tables, databases, …) as the rest of the
 * component's code. Resolving eagerly makes a bad reference fail the component
 * load — visible at deploy time — instead of failing silently at first fire.
 */
async function resolveHandler(
	scope,
	jobName: string,
	handlerReference: string
): Promise<(context: JobRunContext) => unknown> {
	const hashIndex = handlerReference.indexOf('#');
	const modulePath = hashIndex >= 0 ? handlerReference.slice(0, hashIndex) : handlerReference;
	const exportName = hashIndex >= 0 ? handlerReference.slice(hashIndex + 1) : 'default';
	const absolutePath = isAbsolute(modulePath) ? modulePath : join(scope.directory, modulePath);
	let handlerModule;
	try {
		handlerModule = await scope.import(absolutePath);
	} catch (error) {
		// User modules can throw primitives or frozen errors, so wrap (with
		// cause) instead of mutating the caught value's message
		const loadError = new SchedulerConfigError(
			`Scheduler job "${jobName}" in component ${scope.appName}: could not load handler module "${modulePath}": ${safeErrorMessage(error)}`
		);
		loadError.cause = error;
		throw loadError;
	}
	const handler = handlerModule?.[exportName];
	if (typeof handler !== 'function') {
		throw new SchedulerConfigError(
			`Scheduler job "${jobName}" in component ${scope.appName}: "${modulePath}" has no function export named "${exportName}"`
		);
	}
	return handler;
}
