'use strict';

// jobProcess is a worker IIFE keyed off process.env and cannot be imported, so how it records a
// handler's result lives in recordJobResult, which it calls.

const assert = require('node:assert');
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
