'use strict';

// jobProcess is a worker IIFE keyed off process.env and cannot be imported in-process, so how it
// records a handler's result lives in recordJobResult, which it calls; the worker itself runs in a
// thread at the end of this file.

const assert = require('node:assert');
const { waitFor } = require('../../waitFor.js');
const { JOB_STATUS_ENUM } = require('#src/utility/hdbTerms');
const { DeferredJobCompletion, JobCompletion, recordJobResult } = require('#src/server/jobs/deferredJobCompletion');

describe('recordJobResult', function () {
	it('leaves a deferred job IN_PROGRESS, naming what will settle it, and hands back its continuation', function () {
		const afterRecorded = () => {};
		const jobObj = { id: 'job-1' };

		const continuation = recordJobResult(
			jobObj,
			new DeferredJobCompletion('restore-intent', 'runs at the next startup', { backup_id: 3 }, afterRecorded)
		);

		assert.strictEqual(continuation.afterRecorded, afterRecorded);
		assert.deepStrictEqual(jobObj, {
			id: 'job-1',
			status: JOB_STATUS_ENUM.IN_PROGRESS,
			deferred_to: 'restore-intent',
			message: 'runs at the next startup',
			result: { backup_id: 3 },
		});
	});

	it('completes any other result, as a message or a result', function () {
		const withMessage = { id: 'job-2' };
		assert.strictEqual(recordJobResult(withMessage, 'loaded 3 records'), undefined);
		assert.strictEqual(withMessage.status, JOB_STATUS_ENUM.COMPLETE);
		assert.strictEqual(withMessage.message, 'loaded 3 records');
		assert.ok(withMessage.end_datetime);
		assert.ok(!('deferred_to' in withMessage));

		const withResult = { id: 'job-3' };
		recordJobResult(withResult, { backup_id: 4 });
		assert.strictEqual(withResult.status, JOB_STATUS_ENUM.COMPLETE);
		assert.deepStrictEqual(withResult.result, { backup_id: 4 });
		assert.strictEqual(withResult.message, 'Successfully completed job: job-3');
	});

	it('completes a JobCompletion with its result, and hands back what runs after the row write, recorded or not', function () {
		const afterRecorded = () => {};
		const jobObj = { id: 'job-4' };

		const continuation = recordJobResult(jobObj, new JobCompletion({ restarting: true }, afterRecorded));

		assert.deepStrictEqual(
			continuation,
			{ afterRecorded, onNotRecorded: afterRecorded },
			'the work is done either way'
		);
		assert.strictEqual(jobObj.status, JOB_STATUS_ENUM.COMPLETE);
		assert.deepStrictEqual(jobObj.result, { restarting: true });
		assert.strictEqual(jobObj.message, 'Successfully completed job: job-4');
		assert.ok(jobObj.end_datetime);
	});
});

// The job worker itself, run in a thread with its row I/O and dispatch stubbed: the deferred job's
// continuation (the drained restart) runs only once its row records the deferral, and is withdrawn
// otherwise, or the pending restore would fire at some unrelated later restart. Its stubs replace
// exports, which only the compiled build allows, hence `#js`.
describe('jobProcess', function () {
	this.timeout(60000);

	async function runJobWorker({ updateJobFails, asyncWithdraw = false }) {
		const { Worker } = require('node:worker_threads');
		const worker = new Worker(
			`
			const { workerData, parentPort } = require('node:worker_threads');
			const jobs = require(workerData.jobs);
			const serverUtilities = require(workerData.serverUtilities);
			const application = require(workerData.application);
			const { DeferredJobCompletion } = require(workerData.deferred);
			jobs.getJobById = async (id) => [{ id, request: { operation: 'restore_backup' } }];
			jobs.updateJob = async (jobObj) => {
				parentPort.postMessage({ type: 'updateJob', status: jobObj.status, deferred_to: jobObj.deferred_to });
				if (workerData.updateJobFails) throw new Error('the job table is unavailable');
			};
			application.getEnvBuiltInComponents = () => [];
			if (workerData.asyncWithdraw)
				require(workerData.databases).closeLoadedDatabases = async () => parentPort.postMessage({ type: 'cleanup' });
			serverUtilities.getOperationFunction = () => ({
				job_operation_function: async () =>
					new DeferredJobCompletion(
						'restore-intent',
						'runs at the next startup',
						undefined,
						() => parentPort.postMessage({ type: 'continued' }),
						workerData.asyncWithdraw
							? () => new Promise((resolve) => setTimeout(resolve, 100)).then(() => parentPort.postMessage({ type: 'withdrawn' }))
							: () => parentPort.postMessage({ type: 'withdrawn' })
					),
			});
			require(workerData.jobProcess);
			`,
			{
				eval: true,
				env: { ...process.env, PROCESS_NAME: 'JOB-deferred-job-test' },
				workerData: {
					updateJobFails,
					asyncWithdraw,
					databases: require.resolve('#js/resources/databases'),
					jobs: require.resolve('#js/server/jobs/jobs'),
					serverUtilities: require.resolve('#js/server/serverHelpers/serverUtilities'),
					application: require.resolve('#js/components/Application'),
					deferred: require.resolve('#js/server/jobs/deferredJobCompletion'),
					jobProcess: require.resolve('#js/server/jobs/jobProcess'),
				},
			}
		);
		const messages = [];
		// the thread's own reports (resource metrics) share the port; only this harness's messages count
		const harnessTypes = new Set(['updateJob', 'continued', 'withdrawn', 'cleanup']);
		worker.on('message', (message) => harnessTypes.has(message?.type) && messages.push(message));
		const errors = [];
		worker.on('error', (error) => errors.push(error));
		let exited = false;
		worker.on('exit', () => (exited = true));
		try {
			// the worker exits on its own once it has recorded the row and continued, or decided not to
			await waitFor(() => exited || errors.length > 0, {
				timeout: 30000,
				message: () => `the job worker never finished: ${JSON.stringify(messages)}`,
			});
		} finally {
			await worker.terminate();
		}
		assert.deepStrictEqual(errors, []);
		return messages;
	}

	it('runs the continuation once the row records the deferral', async function () {
		const messages = await runJobWorker({ updateJobFails: false });
		assert.deepStrictEqual(messages, [
			{ type: 'updateJob', status: JOB_STATUS_ENUM.IN_PROGRESS, deferred_to: 'restore-intent' },
			{ type: 'continued' },
		]);
	});

	it('withdraws instead of continuing when the row could not record the deferral', async function () {
		const messages = await runJobWorker({ updateJobFails: true });
		assert.deepStrictEqual(messages, [
			{ type: 'updateJob', status: JOB_STATUS_ENUM.IN_PROGRESS, deferred_to: 'restore-intent' },
			{ type: 'withdrawn' },
		]);
	});

	it('finishes an asynchronous withdrawal before releasing its database handles', async function () {
		const messages = await runJobWorker({ updateJobFails: true, asyncWithdraw: true });
		assert.deepStrictEqual(messages, [
			{ type: 'updateJob', status: JOB_STATUS_ENUM.IN_PROGRESS, deferred_to: 'restore-intent' },
			{ type: 'withdrawn' },
			{ type: 'cleanup' },
		]);
	});
});
