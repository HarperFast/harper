'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const sinon = require('sinon');
const { JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const { getDatabases } = require('#src/resources/databases');
const {
	JOB_OWNER_ATTRIBUTES,
	JOB_OWNER_INSTANCE_ID,
	reconcileInterruptedJobs,
	reconcileInterruptedJobsOnce,
	stampJobOwner,
} = require('#src/server/jobs/jobOwnership');
const manageThreads = require('#js/server/threads/manageThreads');
const jobs = require('#src/server/jobs/jobs');

function jobTable() {
	return getDatabases().system[SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
}

async function seedJob(overrides) {
	const id = randomUUID();
	await jobTable().put({
		id,
		type: 'csv_data_load',
		status: JOB_STATUS_ENUM.IN_PROGRESS,
		start_datetime: Date.now(),
		created_datetime: Date.now(),
		...overrides,
	});
	return id;
}

async function statusOf(id) {
	return (await jobTable().get(id))?.status;
}

async function removeSeededJobs(ids) {
	for (const id of ids)
		await jobTable()
			.delete(id)
			.catch(() => {});
}

describe('jobOwnership', function () {
	let seeded;

	before(async function () {
		await testUtils.ensureSystemTables();
	});

	beforeEach(function () {
		seeded = [];
	});

	afterEach(async function () {
		await removeSeededJobs(seeded);
	});

	describe('stampJobOwner', function () {
		it('records this process as the owner', function () {
			const job = {};
			stampJobOwner(job);
			assert.strictEqual(job.owner_instance, JOB_OWNER_INSTANCE_ID);
			assert.strictEqual(job.owner_pid, process.pid);
		});

		it('a separate Harper process mints a different id, which is what makes a restart detectable', function () {
			const fixture = join(__dirname, 'fixtures', 'reportIncarnation.cjs');
			const first = execFileSync(process.execPath, [fixture], { encoding: 'utf8' }).trim();
			const second = execFileSync(process.execPath, [fixture], { encoding: 'utf8' }).trim();

			assert.ok(first, 'a Harper process must mint an owner id');
			assert.notStrictEqual(first, second, 'two processes must not share an owner id');
			assert.notStrictEqual(first, JOB_OWNER_INSTANCE_ID, 'a child process must not share this one');
		});

		it('identifies the process by the thread fabric incarnation, not the pid', function () {
			assert.strictEqual(typeof JOB_OWNER_INSTANCE_ID, 'string');
			assert.notStrictEqual(JOB_OWNER_INSTANCE_ID, String(process.pid));
			assert.strictEqual(
				JOB_OWNER_INSTANCE_ID,
				manageThreads.processIncarnation,
				'job ownership and the thread fabric must share one definition of process identity'
			);
		});
	});

	describe('reconcileInterruptedJobs', function () {
		it('settles an IN_PROGRESS job whose owning process is gone', async function () {
			const id = await seedJob({ owner_instance: randomUUID(), owner_pid: 999999 });
			seeded.push(id);

			assert.strictEqual(await reconcileInterruptedJobs(), 1);

			const job = await jobTable().get(id);
			assert.strictEqual(job.status, JOB_STATUS_ENUM.ERROR);
			assert.match(job.message, /interrupted/i);
			assert.match(job.message, /999999/);
			assert.match(job.message, /outcome is unknown/i, 'the job may have applied some of its effects');
			assert.ok(job.end_datetime, 'a settled job must carry an end time');
		});

		it('settles a CREATED job that never reached its worker', async function () {
			const id = await seedJob({ status: JOB_STATUS_ENUM.CREATED, owner_instance: randomUUID() });
			seeded.push(id);

			assert.strictEqual(await reconcileInterruptedJobs(), 1);
			assert.strictEqual(await statusOf(id), JOB_STATUS_ENUM.ERROR);
		});

		it('settles a row written before ownership was recorded', async function () {
			const id = await seedJob({});
			seeded.push(id);

			assert.strictEqual(await reconcileInterruptedJobs(), 1);
			const job = await jobTable().get(id);
			assert.strictEqual(job.status, JOB_STATUS_ENUM.ERROR);
			assert.match(job.message, /an earlier Harper process/);
		});

		it('leaves a job this process still owns alone', async function () {
			const id = await seedJob({ owner_instance: JOB_OWNER_INSTANCE_ID, owner_pid: process.pid });
			seeded.push(id);

			assert.strictEqual(await reconcileInterruptedJobs(), 0);
			assert.strictEqual(await statusOf(id), JOB_STATUS_ENUM.IN_PROGRESS);
		});

		it('leaves finished jobs alone, whoever owned them', async function () {
			const complete = await seedJob({ status: JOB_STATUS_ENUM.COMPLETE, owner_instance: randomUUID() });
			const errored = await seedJob({ status: JOB_STATUS_ENUM.ERROR, owner_instance: randomUUID() });
			seeded.push(complete, errored);

			assert.strictEqual(await reconcileInterruptedJobs(), 0);
			assert.strictEqual(await statusOf(complete), JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(await statusOf(errored), JOB_STATUS_ENUM.ERROR);
		});

		it('is idempotent — a second pass finds nothing left to settle', async function () {
			const id = await seedJob({ owner_instance: randomUUID() });
			seeded.push(id);

			assert.strictEqual(await reconcileInterruptedJobs(), 1);
			assert.strictEqual(await reconcileInterruptedJobs(), 0);
			assert.strictEqual(await statusOf(id), JOB_STATUS_ENUM.ERROR);
		});
	});

	describe('job rows', function () {
		it('addJob stamps the owner so a later boot can settle the row', async function () {
			const result = await jobs.addJob({ operation: 'restart_service', service: 'http_workers' });
			assert.ok(result.success, result.error || result.message);
			seeded.push(result.createdJob.id);

			const stored = await jobTable().get(result.createdJob.id);
			assert.strictEqual(stored.owner_instance, JOB_OWNER_INSTANCE_ID);
			assert.strictEqual(stored.owner_pid, process.pid);
		});

		it('get_job does not expose the internal owner bookkeeping', async function () {
			const id = await seedJob({ owner_instance: JOB_OWNER_INSTANCE_ID, owner_pid: process.pid });
			seeded.push(id);

			const [job] = await jobs.handleGetJob({ id });
			for (const attribute of JOB_OWNER_ATTRIBUTES) {
				assert.ok(!(attribute in job), `${attribute} must not be returned to clients`);
			}
			assert.strictEqual(job.id, id);
		});

		it('get_jobs_by_start_date does not expose it either', async function () {
			const start = Date.now();
			const id = await seedJob({ owner_instance: JOB_OWNER_INSTANCE_ID, owner_pid: process.pid });
			seeded.push(id);

			const result = await jobs.handleGetJobsByStartDate({
				from_date: new Date(start - 60_000).toISOString(),
				to_date: new Date(start + 60_000).toISOString(),
			});
			const job = result.find((row) => row.id === id);
			assert.ok(job, 'the seeded job should be in the date range');
			for (const attribute of JOB_OWNER_ATTRIBUTES) {
				assert.ok(!(attribute in job), `${attribute} must not be returned to clients`);
			}
		});
	});

	// One ordered narrative, because these share the process-lifetime memo on purpose: a pass that
	// left rows stuck must not count as done, and only a complete pass may be cached. The failure
	// cases have to run before the success case that finally spends the guard.
	describe('reconcileInterruptedJobsOnce', function () {
		// One ordered narrative sharing the process-lifetime memo on purpose: a pass that left rows stuck
		// must not count as done, and only a complete pass may be cached. These rows deliberately outlive
		// the outer afterEach, because the straggler has to survive into the retry.
		let stuck;
		let settleable;
		let later;

		after(async function () {
			await removeSeededJobs([settleable, stuck, later].filter(Boolean));
		});

		afterEach(function () {
			sinon.restore();
		});

		it('a pass that cannot settle every row reports the shortfall instead of resolving', async function () {
			settleable = await seedJob({ owner_instance: randomUUID() });
			stuck = await seedJob({ owner_instance: randomUUID() });

			const updateJob = jobs.updateJob;
			sinon.stub(jobs, 'updateJob').callsFake(async (job) => {
				if (job.id === stuck) throw new Error('simulated write failure');
				return updateJob(job);
			});

			await assert.rejects(reconcileInterruptedJobsOnce(), /Could not settle 1 of 2/);

			assert.strictEqual(
				await statusOf(settleable),
				JOB_STATUS_ENUM.ERROR,
				'one unwritable row must not strand the rest'
			);
			assert.strictEqual(await statusOf(stuck), JOB_STATUS_ENUM.IN_PROGRESS);
		});

		it('retries the straggler on the next call rather than returning a cached result', async function () {
			// The memo was cleared by the rejection above, so this is a real second sweep.
			assert.strictEqual(await reconcileInterruptedJobsOnce(), 1);
			assert.strictEqual(await statusOf(stuck), JOB_STATUS_ENUM.ERROR);
		});

		it('caches a complete pass, so a reload does not re-walk job history', async function () {
			// Stands in for a root component reload after a new job has been created.
			later = await seedJob({ owner_instance: randomUUID() });

			assert.strictEqual(await reconcileInterruptedJobsOnce(), 1, 'the cached result, not a third sweep');
			assert.strictEqual(await statusOf(later), JOB_STATUS_ENUM.IN_PROGRESS);
		});
	});
});
