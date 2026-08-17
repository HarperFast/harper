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

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COVERAGE_REQUIRED, isTrivialChange, reportedCrossModelReviews } from './reviewGate.mjs';

const NON_MEMBER_ASSOCIATIONS = new Set([
	'COLLABORATOR',
	'CONTRIBUTOR',
	'FIRST_TIME_CONTRIBUTOR',
	'FIRST_TIMER',
	'MANNEQUIN',
	'NONE',
]);

/** The whole decision, pure. `pr` is the pull_request object from the Actions event
 *  payload. Returns { pass, exempt, summary, detail } — `pass` already accounts for mode. */
export function evaluateCiCoverage(pr, { mode = 'report', required = COVERAGE_REQUIRED } = {}) {
	const login = String(pr?.user?.login ?? '');
	const assoc = String(pr?.author_association ?? '');
	const body = String(pr?.body ?? '');
	const { count, families } = reportedCrossModelReviews(body);
	const plural = count === 1 ? 'review' : 'reviews';
	const reported = `${count} cross-model ${plural} reported${families.length ? ` (${families.join(', ')})` : ''}`;
	const coverage = count >= required ? reported : `${reported} — policy asks for ${required}`;

	// The Human-Review-Need footer is evidence a prepush review RAN; staleness means
	// commits landed after the last reviewed head (HEG step 14's most-skipped step).
	const footer = [...body.matchAll(/Human-Review-Need:\s*(\d+)(?:[^@\n]*@\s*([0-9a-f]{6,40}))?/gi)].at(-1);
	const head = String(pr?.head?.sha ?? '').toLowerCase();
	const footerNote = !footer
		? 'no Human-Review-Need footer'
		: !footer[2]
			? `Human-Review-Need: ${footer[1]} @ unpinned sha`
			: head.startsWith(footer[2].toLowerCase())
				? `Human-Review-Need: ${footer[1]} @ head`
				: `Human-Review-Need footer is STALE (reviewed @ ${footer[2].slice(0, 7)}, head is ${head.slice(0, 7)})`;

	// The triviality exemption requires the size fields to actually be present: a payload
	// missing additions/deletions would otherwise read as 0+0 and silently exempt everything.
	const sized = Number.isFinite(pr?.additions) && Number.isFinite(pr?.deletions);
	const exempt =
		login.endsWith('[bot]') || pr?.user?.type === 'Bot'
			? 'bot author'
			: NON_MEMBER_ASSOCIATIONS.has(assoc)
				? `author is not an org member (${assoc}) — always human review`
				: sized && isTrivialChange(pr?.additions, pr?.deletions)
					? 'trivial change (≤2 lines)'
					: pr?.draft
						? 'draft — checked again at ready-for-review'
						: '';
	const compliant = count >= required;
	const pass = mode !== 'enforce' || Boolean(exempt) || compliant;
	const summary = exempt ? `exempt: ${exempt}` : coverage;
	return { pass, exempt, compliant, count, families, summary, detail: `${coverage}; ${footerNote}` };
}

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
	// report mode stays green, but an under-reported PR still gets the count on the PR
	// surface as a warning annotation rather than only in the job summary
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

function invokedDirectly() {
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}
if (invokedDirectly()) {
	const mode = arg('mode', process.env.INPUT_MODE || process.env.REVIEW_COVERAGE_MODE || 'report').toLowerCase();
	if (mode !== 'report' && mode !== 'enforce') {
		// a typo'd mode must be loud — 'enfroce' silently meaning report is the bad direction
		console.error(`::error::review-coverage: unknown mode '${mode}' (report|enforce)`);
		process.exitCode = 1;
	} else {
		try {
			main(mode);
		} catch (error) {
			// plumbing failures follow the mode: informational stays green, but an enforcing
			// check that cannot read its payload must not silently wave PRs through
			console.error(
				`review-coverage: ${error.message}${mode === 'enforce' ? '' : ' (passing — report mode fails only on policy)'}`
			);
			if (mode === 'enforce') {
				console.error(
					`::error::review-coverage could not evaluate this PR (${error.message}) — enforce mode fails closed`
				);
				process.exitCode = 1;
			}
		}
	}
}
