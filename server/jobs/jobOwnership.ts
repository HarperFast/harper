'use strict';

import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { getDatabases } from '../../resources/databases.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import log from '../../utility/logging/harper_logger.ts';
import { updateJob } from './jobs.ts';

/**
 * Which Harper process owns a job row, and the boot pass that settles the rows whose owner is gone.
 *
 * A job runs in a worker thread and dies with its process, but nothing in the jobs subsystem ever
 * revisits a row afterwards: `jobRunner` writes IN_PROGRESS before launching the worker and the
 * worker writes COMPLETE/ERROR in its own `finally`, so a crash, a `restart`, or an orchestrator
 * replacing the container leaves the row at CREATED or IN_PROGRESS permanently. `get_job` then
 * reports a job that no longer exists as still running.
 *
 * Ownership is a per-process id rather than a pid: pids are reused, and a reused pid would make a
 * dead job look alive. The id is minted once on the main thread and inherited by every worker
 * through `process.env`, so all threads of one Harper process agree on it, while any restart —
 * self-relaunch or orchestrator — produces a new process and therefore a new id. The pid is carried
 * alongside it for diagnostics only.
 */
const JOB_OWNER_INSTANCE_ENV = 'HARPER_JOB_OWNER_INSTANCE';
if (isMainThread) process.env[JOB_OWNER_INSTANCE_ENV] = randomUUID();
export const JOB_OWNER_INSTANCE_ID = process.env[JOB_OWNER_INSTANCE_ENV] ?? randomUUID();

/** Internal bookkeeping stamped on every job row; stripped from `get_job` responses. */
export const JOB_OWNER_ATTRIBUTES = ['owner_instance', 'owner_pid'] as const;

/** A job that has neither completed nor failed, so its owning process is still responsible for it. */
const UNFINISHED_JOB_STATUSES = [hdbTerms.JOB_STATUS_ENUM.CREATED, hdbTerms.JOB_STATUS_ENUM.IN_PROGRESS];

export function stampJobOwner(job: any): void {
	job.owner_instance = JOB_OWNER_INSTANCE_ID;
	job.owner_pid = process.pid;
}

/**
 * Settle every job row left unfinished by a process that is no longer running, and report how many
 * were settled.
 *
 * Safe to call more than once: a row this process owns is skipped, and a row it does not own is
 * moved to a terminal status, so a second pass finds nothing. Boot is the only place it needs to
 * run, because a row owned by a live process is by definition still someone's responsibility.
 *
 * Interrupted rows are reported as ERROR rather than a new status: every consumer of `get_job`
 * already handles ERROR, and the distinction lives in the message.
 */
export async function reconcileInterruptedJobs(): Promise<number> {
	const jobTable = (getDatabases() as any).system?.[hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
	if (!jobTable) return 0;

	// Collect before writing: the search walks the `status` attribute these updates change.
	const interrupted: Array<{ id: any; owner_pid: any }> = [];
	for (const status of UNFINISHED_JOB_STATUSES) {
		for await (const job of jobTable.search([{ attribute: 'status', value: status }])) {
			if (job.owner_instance !== JOB_OWNER_INSTANCE_ID) interrupted.push({ id: job.id, owner_pid: job.owner_pid });
		}
	}

	let settled = 0;
	for (const { id, owner_pid } of interrupted) {
		const owner = owner_pid === undefined ? 'an earlier Harper process' : `Harper process ${owner_pid}`;
		try {
			await updateJob({
				id,
				status: hdbTerms.JOB_STATUS_ENUM.ERROR,
				message: `Job was interrupted: ${owner} exited before it finished. Rerun the operation.`,
			});
			settled++;
		} catch (error) {
			log.error(`Could not settle interrupted job ${id}`, error);
		}
	}
	if (settled > 0) log.warn(`Settled ${settled} job(s) left unfinished by a Harper process that is no longer running`);
	return settled;
}
