#!/usr/bin/env node
'use strict';
/**
 * Upsert a sticky comment on a PR/issue keyed by a marker string.
 *
 * Usage: upsert-sticky-comment.js <pr-number> <marker> <body>
 *
 * Requires GH_TOKEN and GITHUB_REPOSITORY in the environment. Uses `gh` so we
 * don't need to vendor an HTTP client.
 */

const { execSync } = require('child_process');

const [, , prNumber, marker, body] = process.argv;
if (!prNumber || !marker || !body) {
	console.error('Usage: upsert-sticky-comment.js <pr-number> <marker> <body>');
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

if (existing) {
	gh(`api --method PATCH "repos/${repo}/issues/comments/${existing.id}" -f body=@-`, body);
	console.log(`Updated comment ${existing.id}`);
} else {
	gh(`api --method POST "repos/${repo}/issues/${prNumber}/comments" -f body=@-`, body);
	console.log('Created sticky comment');
}
