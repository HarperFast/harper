#!/usr/bin/env node
'use strict';
/**
 * Upsert a sticky comment on a PR/issue keyed by a marker string.
 *
 * Usage: upsert-sticky-comment.js <pr-number> <marker> <body>
 *        upsert-sticky-comment.js --read-head <pr-number> <marker>
 *
 * The second form reads back the SHA sticky-head.js recorded in the existing
 * comment (branch-guard.js's durable record of what the workflow last
 * pushed), printing it to stdout, or nothing if there is no comment or no
 * recorded head.
 *
 * Requires GH_TOKEN and GITHUB_REPOSITORY in the environment. Uses `gh` so we
 * don't need to vendor an HTTP client.
 */

const { execSync } = require('child_process');
const { extractRecordedHead } = require('./sticky-head.js');

const readHead = process.argv[2] === '--read-head';
const [prNumber, marker, body] = readHead ? process.argv.slice(3) : process.argv.slice(2);
if (!prNumber || !marker || (!readHead && !body)) {
	console.error('Usage: upsert-sticky-comment.js <pr-number> <marker> <body>');
	console.error('       upsert-sticky-comment.js --read-head <pr-number> <marker>');
	process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
	console.error('GITHUB_REPOSITORY not set');
	process.exit(2);
}

function gh(args, input) {
	return execSync(`gh ${args}`, {
		encoding: 'utf8',
		input,
		stdio: input ? ['pipe', 'pipe', 'inherit'] : ['ignore', 'pipe', 'inherit'],
	});
}

const comments = JSON.parse(gh(`api "repos/${repo}/issues/${prNumber}/comments" --paginate`));
const existing = comments.find((c) => c.body && c.body.includes(marker));

if (readHead) {
	const head = existing ? extractRecordedHead(existing.body) : null;
	if (head) process.stdout.write(head + '\n');
	process.exit(0);
}

if (existing) {
	gh(`api --method PATCH "repos/${repo}/issues/comments/${existing.id}" -F body=@-`, body);
	console.log(`Updated comment ${existing.id}`);
} else {
	gh(`api --method POST "repos/${repo}/issues/${prNumber}/comments" -F body=@-`, body);
	console.log('Created sticky comment');
}
