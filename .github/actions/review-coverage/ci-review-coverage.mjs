#!/usr/bin/env node
// CI surface for the human-review gate (policy: skills/pr-shepherd/SKILL.md; enforcement:
// dispatch/lib/reviewGate.mjs via ReviewApi). This check makes coverage REPORTING visible
// on the PR itself at open/edit time. It deliberately cannot replicate the gate: CI never
// sees the fleet review's verdict, so demanding coverage here is STRICTER than policy
// (the gate waives coverage for clean reviews). Hence two modes:
//   report  (default) — always green; the check text and job summary carry the count
//   enforce — red when a member-authored, non-trivial, non-draft PR reports <2
// Run from the JavaScript action in this directory, or locally:
//   node .github/actions/review-coverage/ci-review-coverage.mjs --event <payload.json> [--mode enforce]

import { appendFileSync, readFileSync } from 'node:fs';
import { evaluateCiCoverage } from './evaluateCiCoverage.mjs';
import { COVERAGE_REQUIRED } from './reviewGate.mjs';

function arg(name, fallback = '') {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main(mode) {
	const eventPath = arg('event', process.env.GITHUB_EVENT_PATH ?? '');
	if (!eventPath) throw new Error('no event payload (--event or GITHUB_EVENT_PATH)');
	const pr = JSON.parse(readFileSync(eventPath, 'utf8')).pull_request;
	if (!pr) throw new Error('event payload has no pull_request');
	const rawRequired = arg('required', process.env.INPUT_REQUIRED || process.env.REVIEW_COVERAGE_REQUIRED || '');
	const required = rawRequired === '' ? COVERAGE_REQUIRED : Number(rawRequired);
	if (!Number.isInteger(required) || required < 0) throw new Error(`invalid required '${rawRequired}'`);
	const r = evaluateCiCoverage(pr, { mode, required });

	const lines = [
		`### Cross-model review coverage — ${r.pass ? (r.exempt ? '✅ exempt' : r.compliant ? '✅' : '⚠️ report-only') : '❌'}`,
		'',
		r.detail,
		'',
		r.exempt
			? `_${r.exempt}_`
			: r.compliant
				? ''
				: `Per team policy, a substantive PR is queued for human review only after ${required} cross-model reviews are run and reported in the description (\`## Review coverage\` naming each model — see harper-engineering-guidelines). The dispatch review gate enforces this when the fleet's review finds issues; this check just makes the reporting visible early.`,
	].filter(Boolean);
	if (process.env.GITHUB_STEP_SUMMARY) {
		try {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
		} catch (error) {
			console.error(`::warning::review-coverage could not write the step summary (${error.message})`);
		}
	}
	console.log(`review-coverage [${mode}]: ${r.exempt ? r.summary : r.detail}`);
	if (r.pass && !r.exempt && !r.compliant)
		console.error(
			`::warning::${r.detail} — the dispatch gate will block at review time if the fleet's review finds issues`
		);
	if (!r.pass) {
		console.error(
			`::error::${r.detail} — report the reviews in the PR description to pass; the dispatch gate will block at review time if the fleet's review also finds issues`
		);
		process.exitCode = 1;
	}
}

const mode = arg('mode', process.env.INPUT_MODE || process.env.REVIEW_COVERAGE_MODE || 'report').toLowerCase();
if (mode !== 'report' && mode !== 'enforce') {
	console.error(`::error::review-coverage: unknown mode '${mode}' (report|enforce)`);
	process.exitCode = 1;
} else {
	try {
		main(mode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`review-coverage: ${message}${mode === 'enforce' ? '' : ' (passing — report mode fails only on policy)'}`
		);
		if (mode === 'enforce') {
			console.error(`::error::review-coverage could not evaluate this PR (${message}) — enforce mode fails closed`);
			process.exitCode = 1;
		}
	}
}
