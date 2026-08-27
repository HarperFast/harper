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

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { evaluateCiCoverage } from './evaluateCiCoverage.mjs';
import { evaluatePrFormat } from './evaluatePrFormat.mjs';
import { classifyPullRequest } from './prExemption.mjs';
import { COVERAGE_REQUIRED } from './reviewGate.mjs';

const MAX_PR_FILES_BYTES = 4 * 1024 * 1024;

function arg(name, fallback = '') {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readPrFiles(pr, formatMode) {
	if (formatMode === 'off' || classifyPullRequest(pr).exempt) return null;
	const ready = arg('pr-files-ready', process.env.INPUT_PR_FILES_READY || '').toLowerCase() === 'true';
	const file = arg('pr-files', process.env.INPUT_PR_FILES || '');
	if (!ready || !file) return null;
	const size = statSync(file).size;
	if (size > MAX_PR_FILES_BYTES) throw new Error(`normalized PR-files artifact exceeds ${MAX_PR_FILES_BYTES} bytes`);
	return JSON.parse(readFileSync(file, 'utf8'));
}

function main(mode, formatMode) {
	const eventPath = arg('event', process.env.GITHUB_EVENT_PATH ?? '');
	if (!eventPath) throw new Error('no event payload (--event or GITHUB_EVENT_PATH)');
	const event = JSON.parse(readFileSync(eventPath, 'utf8'));
	const pr = event.pull_request;
	if (!pr) throw new Error('event payload has no pull_request');
	const rawRequired = arg('required', process.env.INPUT_REQUIRED || process.env.REVIEW_COVERAGE_REQUIRED || '');
	const required = rawRequired === '' ? COVERAGE_REQUIRED : Number(rawRequired);
	if (!Number.isInteger(required) || required < 0) throw new Error(`invalid required '${rawRequired}'`);
	const r = evaluateCiCoverage(pr, { mode, required });
	const format = evaluatePrFormat(pr, {
		mode: formatMode,
		repo: String(event.repository?.full_name ?? ''),
		number: Number(event.number ?? pr.number),
		prFiles: readPrFiles(pr, formatMode),
	});

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
	if (formatMode !== 'off') {
		lines.push(
			'',
			`### PR description format — ${format.exempt ? '✅ exempt' : format.compliant ? '✅' : format.draft ? '⚠️ draft' : '⚠️'}`,
			'',
			format.exempt
				? `_${format.exempt}_`
				: format.compliant
					? `${format.links.lineAnchored.length} current line-anchored PR-diff link(s); required structure present.`
					: format.problems.map((problem) => `- ${problem}`).join('\n'),
			'',
			'See `.github/actions/review-coverage/README.md` for the format and remediation.'
		);
	}
	if (process.env.GITHUB_STEP_SUMMARY) {
		try {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
		} catch (error) {
			console.error(`::warning::review-coverage could not write the step summary (${error.message})`);
		}
	}
	console.log(`review-coverage [${mode}]: ${r.exempt ? r.summary : r.detail}`);
	if (formatMode !== 'off')
		console.log(
			`pr-format [${formatMode}]: ${format.exempt ? `exempt: ${format.exempt}` : format.compliant ? 'compliant' : format.problems.join('; ')}`
		);
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
	if (!format.pass) {
		for (const problem of format.problems) console.error(`::error::PR description: ${problem}`);
		process.exitCode = 1;
	} else if (!format.compliant && !format.exempt) {
		for (const problem of format.problems) console.error(`::warning::PR description: ${problem}`);
	}
}

const mode = arg('mode', process.env.INPUT_MODE || process.env.REVIEW_COVERAGE_MODE || 'report').toLowerCase();
const formatMode = arg('format-mode', process.env.INPUT_FORMAT_MODE || 'off').toLowerCase();
if (!['report', 'enforce'].includes(mode)) {
	console.error(`::error::review-coverage: unknown mode '${mode}' (report|enforce)`);
	process.exitCode = 1;
} else if (!['off', 'report', 'enforce'].includes(formatMode)) {
	console.error(`::error::review-coverage: unknown format mode '${formatMode}' (off|report|enforce)`);
	process.exitCode = 1;
} else {
	try {
		main(mode, formatMode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`review-coverage: ${message}${mode === 'enforce' || formatMode === 'enforce' ? '' : ' (passing — report mode fails only on policy)'}`
		);
		if (mode === 'enforce' || formatMode === 'enforce') {
			console.error(`::error::review-coverage could not evaluate this PR (${message}) — enforce mode fails closed`);
			process.exitCode = 1;
		}
	}
}
