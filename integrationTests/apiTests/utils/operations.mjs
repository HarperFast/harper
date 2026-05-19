import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

/**
 * Pull the job ID out of a Harper async-operation response body. Asserts that
 * the `job_id` field is present and that the human-readable message agrees
 * (the message is of the form `"Started job with id <uuid>"`).
 *
 * @param {{ job_id?: string, message?: string }} body
 */
export function getJobId(body) {
	assert.ok(body.hasOwnProperty('job_id'), JSON.stringify(body));
	assert.equal(body.message.split(' ')[4], body.job_id, JSON.stringify(body));
	return body.job_id;
}

/**
 * Poll `get_job` until the job leaves `IN_PROGRESS` or the timeout expires.
 * Returns the final supertest response so callers can assert against the
 * job body shape.
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {string} jobId
 * @param {number} [timeoutSeconds]
 */
export async function awaitJob(client, jobId, timeoutSeconds = 15) {
	let response = null;
	let elapsed = 0;
	do {
		response = await client.req().send({ operation: 'get_job', id: jobId }).expect(200);
		if (response.body[0]?.status !== 'IN_PROGRESS') break;
		await setTimeout(1000);
		elapsed++;
	} while (elapsed < timeoutSeconds);
	return response;
}

/**
 * Poll `get_job` and assert the job reached `COMPLETE` (or `ERROR` if an
 * `expectedError` substring is given). Returns the job message.
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {string} jobId
 * @param {{ expectedError?: string, expectedMessage?: string, timeoutSeconds?: number }} [options]
 */
export async function awaitJobCompleted(client, jobId, options = {}) {
	const { expectedError, expectedMessage, timeoutSeconds = 30 } = options;

	const response = await awaitJob(client, jobId, timeoutSeconds);
	const job = response.body[0];
	assert.ok(job, `expected job body, got: ${response.text}`);
	assert.ok(job.hasOwnProperty('status'), response.text);

	if (job.status === 'ERROR') {
		if (!expectedError) {
			assert.fail(`Job ${jobId} ERRORed unexpectedly: ${response.text}`);
		}
		const message = typeof job.message === 'string' ? job.message : (job.message?.error ?? '');
		assert.ok(
			message.includes(expectedError),
			`Job ${jobId} ERROR message "${message}" did not include "${expectedError}": ${response.text}`
		);
		return message;
	}

	assert.equal(job.status, 'COMPLETE', `Job ${jobId} did not complete: ${response.text}`);
	if (expectedMessage) {
		assert.ok(
			job.message.includes(expectedMessage),
			`Job ${jobId} COMPLETE message "${job.message}" did not include "${expectedMessage}": ${response.text}`
		);
	}
	return job.message;
}
