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
		const status = response.body?.[0]?.status;
		// Stop only on a terminal status. A freshly-started job is briefly
		// CREATED (queued, before the worker flips it to IN_PROGRESS) and a
		// just-created job record can momentarily come back empty; returning on
		// "anything that isn't IN_PROGRESS" would hand the caller a job that
		// hasn't run yet. Keep polling until COMPLETE/ERROR or the timeout.
		if (status === 'COMPLETE' || status === 'ERROR') break;
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

/**
 * Poll `produce` until `until(value)` is satisfied or the timeout expires, then
 * return the most recent produced value. The caller asserts on the returned
 * value so a timeout still surfaces a precise failure (e.g. the wrong count).
 * Use this in place of `await setTimeout(n)` followed by a one-shot assertion on
 * an asynchronous side effect — the source of the fixed-delay races in #1222.
 *
 * @template T
 * A transient failure from `produce`/`until` (e.g. a momentary non-200 under CI
 * contention) is swallowed and retried; the error is re-thrown only if it
 * happens on the final attempt, so a persistent failure still surfaces.
 *
 * @param {() => Promise<T> | T} produce  Produces the current value (e.g. runs a query).
 * @param {{ until: (value: T) => boolean, timeoutSeconds?: number, intervalMs?: number }} options
 * @returns {Promise<T>} the last produced value (satisfying `until`, or the final attempt on timeout)
 */
export async function waitFor(produce, { until, timeoutSeconds = 30, intervalMs = 250 } = {}) {
	const attempts = Math.max(1, Math.ceil((timeoutSeconds * 1000) / intervalMs));
	let value;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			value = await produce();
			if (until(value)) return value;
		} catch (error) {
			if (attempt === attempts - 1) throw error;
		}
		if (attempt < attempts - 1) await setTimeout(intervalMs);
	}
	return value;
}
