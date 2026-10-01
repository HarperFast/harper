import assert from 'node:assert';
import test from 'node:test';

import { classifyRemoteHead } from './branch-guard.js';

const WORKFLOW_EMAIL = 'noreply@harperdb.io';
const WORKFLOW_SHA = 'b91234d1dd0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const HUMAN_SHA = '6245fdffa5e8c5f3e1cbb6df3b2d1b6b5fda1234';

test('a branch that does not exist yet is never foreign', () => {
	const result = classifyRemoteHead({ remoteExists: false });
	assert.strictEqual(result.foreign, false);
});

test('remote head matching the recorded head is not foreign', () => {
	const result = classifyRemoteHead({
		remoteExists: true,
		remoteHead: WORKFLOW_SHA,
		recordedHead: WORKFLOW_SHA,
		committerEmail: 'someone-else@example.com',
		workflowEmail: WORKFLOW_EMAIL,
	});
	assert.strictEqual(result.foreign, false);
});

test('remote head diverging from the recorded head is foreign — the real PR #2966 case', () => {
	// The workflow pushed b91234d1d; a human then committed 6245fdffa on top.
	const result = classifyRemoteHead({
		remoteExists: true,
		remoteHead: HUMAN_SHA,
		recordedHead: WORKFLOW_SHA,
		committerEmail: 'kris@harperdb.io',
		workflowEmail: WORKFLOW_EMAIL,
	});
	assert.strictEqual(result.foreign, true);
	assert.match(result.reason, /differs from the last SHA the workflow pushed/);
});

test('backward compat: no recorded head, committer is the workflow identity -> not foreign', () => {
	const result = classifyRemoteHead({
		remoteExists: true,
		remoteHead: WORKFLOW_SHA,
		recordedHead: '',
		committerEmail: WORKFLOW_EMAIL,
		workflowEmail: WORKFLOW_EMAIL,
	});
	assert.strictEqual(result.foreign, false);
	assert.match(result.reason, /predates this guard/);
});

test('backward compat: no recorded head, committer is not the workflow identity -> foreign', () => {
	const result = classifyRemoteHead({
		remoteExists: true,
		remoteHead: HUMAN_SHA,
		recordedHead: '',
		committerEmail: 'kris@harperdb.io',
		workflowEmail: WORKFLOW_EMAIL,
	});
	assert.strictEqual(result.foreign, true);
	assert.match(result.reason, /predates this guard/);
});
