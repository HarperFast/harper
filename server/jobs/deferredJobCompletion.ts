import { JOB_STATUS_ENUM, PROCESS_NAME_ENV_PROP } from '../../utility/hdbTerms.ts';

/**
 * Returned by a job operation whose outcome is decided after its worker exits — a restore that runs at
 * the next startup. The job stays IN_PROGRESS, naming the durable record that will settle it, instead
 * of reading COMPLETE before anything has happened.
 */
export class DeferredJobCompletion {
	owner: string;
	message: string;
	result?: unknown;
	/** Runs once the job row records the deferral, e.g. the restart that carries the job on. */
	afterRecorded?: () => void;
	constructor(owner: string, message: string, result?: unknown, afterRecorded?: () => void) {
		this.owner = owner;
		this.message = message;
		this.result = result;
		this.afterRecorded = afterRecorded;
	}
}

/** The id of the job this thread is running, or undefined outside a job worker. */
export function currentJobId(): string | undefined {
	const processName = process.env[PROCESS_NAME_ENV_PROP];
	return processName?.startsWith('JOB-') ? processName.slice(4) : undefined;
}

/**
 * Records a job handler's return value on its row, and returns what to run once the row is written. A
 * `DeferredJobCompletion` leaves the job IN_PROGRESS, naming the record that will settle it.
 */
export function recordJobResult(jobObj: Record<string, any>, results: unknown): (() => void) | undefined {
	if (results instanceof DeferredJobCompletion) {
		jobObj.status = JOB_STATUS_ENUM.IN_PROGRESS;
		jobObj.deferred_to = results.owner;
		jobObj.message = results.message;
		if (results.result !== undefined) jobObj.result = results.result;
		return results.afterRecorded;
	}
	jobObj.status = JOB_STATUS_ENUM.COMPLETE;
	if (typeof results === 'string') jobObj.message = results;
	else {
		jobObj.result = results;
		jobObj.message = 'Successfully completed job: ' + jobObj.id;
	}
	jobObj.end_datetime = Date.now();
}
