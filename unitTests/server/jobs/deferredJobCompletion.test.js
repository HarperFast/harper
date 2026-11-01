'use strict';

// jobProcess is a worker IIFE keyed off process.env and cannot be imported in-process, so how it
// records a handler's result lives in recordJobResult, which it calls; the worker itself runs in a
// thread at the end of this file.

const assert = require('node:assert');
const { waitFor } = require('../../waitFor.js');
const { JOB_STATUS_ENUM } = require('#src/utility/hdbTerms');
const { DeferredJobCompletion, recordJobResult } = require('#src/server/jobs/deferredJobCompletion');

describe('recordJobResult', function () {
	it('leaves a deferred job IN_PROGRESS, naming what will settle it, and hands back its continuation', function () {
		const afterRecorded = () => {};
		const jobObj = { id: 'job-1' };

		const continuation = recordJobResult(
			jobObj,
			new DeferredJobCompletion('restore-intent', 'runs at the next startup', { backup_id: 3 }, afterRecorded)
		);

		assert.strictEqual(continuation, afterRecorded);
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
});

// The job worker itself, run in a thread with its row I/O and dispatch stubbed: the deferred job's
// continuation (the drained restart) must run even when the row that records the deferral cannot be
// written, or the pending restore would fire at some unrelated later restart.
describe('jobProcess', function () {
	this.timeout(60000);

	async function runJobWorker({ updateJobFails }) {
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
			serverUtilities.getOperationFunction = () => ({
				job_operation_function: async () =>
					new DeferredJobCompletion('restore-intent', 'runs at the next startup', undefined, () =>
						parentPort.postMessage({ type: 'continued' })
					),
			});
			require(workerData.jobProcess);
			`,
			{
				eval: true,
				env: { ...process.env, PROCESS_NAME: 'JOB-deferred-job-test' },
				workerData: {
					updateJobFails,
					jobs: require.resolve('#src/server/jobs/jobs'),
					serverUtilities: require.resolve('#src/server/serverHelpers/serverUtilities'),
					application: require.resolve('#src/components/Application'),
					deferred: require.resolve('#src/server/jobs/deferredJobCompletion'),
					jobProcess: require.resolve('#src/server/jobs/jobProcess'),
				},
			}
		);
		const messages = [];
		worker.on('message', (message) => messages.push(message));
		const errors = [];
		worker.on('error', (error) => errors.push(error));
		try {
			await waitFor(() => messages.some((message) => message.type === 'continued') || errors.length > 0, {
				timeout: 30000,
				message: () => `the job worker never continued: ${JSON.stringify(messages)}`,
			});
		} finally {
			await worker.terminate();
		}
		assert.deepStrictEqual(errors, []);
		return messages;
	}

	for (const updateJobFails of [false, true]) {
		it(`runs the continuation once the row write ${updateJobFails ? 'fails' : 'succeeds'}`, async function () {
			const messages = await runJobWorker({ updateJobFails });
			assert.deepStrictEqual(messages, [
				{ type: 'updateJob', status: JOB_STATUS_ENUM.IN_PROGRESS, deferred_to: 'restore-intent' },
				{ type: 'continued' },
			]);
		});
	}
});
