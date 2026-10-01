#!/usr/bin/env node
'use strict';
/**
 * Decide whether a cherry-pick branch's current remote head is "foreign" —
 * i.e. not something the workflow itself pushed — so callers never
 * reset/force-push/delete over a human's conflict resolution.
 *
 * The rule: compare the remote head against the last SHA the workflow
 * recorded pushing (sticky-head.js). A branch with no recorded head predates
 * this guard; for those, fall back to checking whether the head commit's
 * committer is the workflow's own git identity (what it commits cherry-picks
 * as — see the "Configure git" step in cherry-pick-patch.yml).
 *
 * CLI usage (reads from env, prints a JSON classification to stdout):
 *   REMOTE_EXISTS=true|false REMOTE_HEAD=<sha> RECORDED_HEAD=<sha-or-empty> \
 *   COMMITTER_EMAIL=<email> WORKFLOW_EMAIL=<email> node branch-guard.js
 */

function classifyRemoteHead({ remoteExists, remoteHead, recordedHead, committerEmail, workflowEmail }) {
	if (!remoteExists) {
		return { foreign: false, reason: 'branch does not exist' };
	}
	if (recordedHead) {
		if (remoteHead === recordedHead) {
			return { foreign: false, reason: 'remote head matches the last SHA the workflow pushed' };
		}
		return {
			foreign: true,
			reason: `remote head ${remoteHead} differs from the last SHA the workflow pushed (${recordedHead})`,
		};
	}
	// No recorded head: a branch from before this guard existed, or one whose
	// sticky comment was since overwritten without a head marker. Fall back to
	// the committer identity — if it isn't the workflow's own, something else
	// (a human, most likely) wrote this commit.
	if (committerEmail === workflowEmail) {
		return {
			foreign: false,
			reason: 'no recorded head (predates this guard); head commit committer matches the workflow identity',
		};
	}
	return {
		foreign: true,
		reason: `no recorded head (predates this guard); head commit committer (${committerEmail}) is not the workflow identity (${workflowEmail})`,
	};
}

module.exports = { classifyRemoteHead };

if (require.main === module) {
	const result = classifyRemoteHead({
		remoteExists: process.env.REMOTE_EXISTS === 'true',
		remoteHead: process.env.REMOTE_HEAD || '',
		recordedHead: process.env.RECORDED_HEAD || '',
		committerEmail: process.env.COMMITTER_EMAIL || '',
		workflowEmail: process.env.WORKFLOW_EMAIL || '',
	});
	process.stdout.write(JSON.stringify(result) + '\n');
}
