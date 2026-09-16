'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const { getDatabases } = require('#src/resources/databases');
const {
	JOB_OWNER_ATTRIBUTES,
	JOB_OWNER_INSTANCE_ID,
	reconcileInterruptedJobs,
	stampJobOwner,
} = require('#src/server/jobs/jobOwnership');
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

		it('mints an instance id that is not the pid, so a reused pid cannot look alive', function () {
			assert.strictEqual(typeof JOB_OWNER_INSTANCE_ID, 'string');
			assert.notStrictEqual(JOB_OWNER_INSTANCE_ID, String(process.pid));
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
	});
});
