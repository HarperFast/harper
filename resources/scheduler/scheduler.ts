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
 * occurrence twice.
 */
export async function handleApplication(scope): Promise<void> {
	// One worker owns scheduling for the whole node; leadership across nodes is
	// decided in the engine. This gate is correct in every threading mode,
	// including threads:0 where the main thread acts as worker 0.
	if (getWorkerIndex() !== 0) {
		schedulerLogger.debug?.('Skipping scheduler initialization on non-primary worker');
		return;
	}
	const config = scope.options.getAll() ?? {};
	if (config.jobs === undefined) {
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

	registerComponentJobs(scope.appName, jobs);
	// A closing scope (worker shutdown, redeploy, or a discarded
	// deploy-validation load) must take its timers with it
	scope.on('close', () => unregisterComponentJobs(scope.appName));
	startSchedulerEngine();
	schedulerLogger.trace?.(`Registered ${jobs.length} scheduled job(s) for component ${scope.appName}`);
}

async function buildJob(scope, jobConfig: SchedulerJobConfig): Promise<ScheduledJob> {
	const componentName = scope.appName;
	if (typeof jobConfig !== 'object' || jobConfig === null) {
		throw new SchedulerConfigError(`Each scheduler.jobs entry in component ${componentName} must be an object`);
	}
	const { name, cron, interval, timezone, handler } = jobConfig;
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
		if (!(intervalMs >= MIN_INTERVAL_MS)) {
			throw new SchedulerConfigError(
				`Scheduler job "${name}" in component ${componentName}: interval "${interval}" must be at least 1 second (e.g. 90s, 5m, 1h)`
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
