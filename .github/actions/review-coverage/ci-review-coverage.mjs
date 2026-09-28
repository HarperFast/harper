#!/usr/bin/env node
// CI surface for the human-review gate (policy: skills/pr-shepherd/SKILL.md; enforcement:
// dispatch/lib/reviewGate.mjs via ReviewApi). This check makes coverage REPORTING visible
// on the PR itself at open/edit time. It deliberately cannot replicate the gate: CI never
// sees the fleet review's verdict, so demanding coverage here is STRICTER than policy
// (the gate waives coverage for clean reviews). Review coverage hence has two modes:
//   report  (default) — always green; the check text and job summary carry the count
//   enforce — red when a member-authored, AI-authored, non-trivial, non-draft PR reports <2
// PR-format and framing-verdict policy are controlled independently by their own inputs.
// Run from the JavaScript action in this directory, or locally:
//   node .github/actions/review-coverage/ci-review-coverage.mjs --event <payload.json> [--mode enforce]

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { validateNormalizedPrFiles } from './collectPrFiles.mjs';
import { evaluateCiCoverage } from './evaluateCiCoverage.mjs';
import { evaluateFramingVerdict, parseFramingPaths } from './evaluateFramingVerdict.mjs';
import { evaluatePrFormat } from './evaluatePrFormat.mjs';
import { EASY_MAX_FILES, EASY_MAX_LINES } from './prExemption.mjs';
import { COVERAGE_REQUIRED } from './reviewGate.mjs';

const MAX_PR_FILES_BYTES = 4 * 1024 * 1024;

// The full documented enum, so an override can only ever land on a value classification
// already understands (see review-coverage.yml for where this input comes from).
const AUTHOR_ASSOCIATIONS = new Set([
	'OWNER',
	'MEMBER',
	'COLLABORATOR',
	'CONTRIBUTOR',
	'FIRST_TIME_CONTRIBUTOR',
	'FIRST_TIMER',
	'MANNEQUIN',
	'NONE',
]);

function arg(name, fallback = '') {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readPrFiles(superseded) {
	if (superseded) return null;
	const ready = arg('pr-files-ready', process.env.INPUT_PR_FILES_READY || '').toLowerCase() === 'true';
	const file = arg('pr-files', process.env.INPUT_PR_FILES || '');
	if (!ready || !file) return null;
	const size = statSync(file).size;
	if (size > MAX_PR_FILES_BYTES) throw new Error(`normalized PR-files artifact exceeds ${MAX_PR_FILES_BYTES} bytes`);
	return validateNormalizedPrFiles(JSON.parse(readFileSync(file, 'utf8')));
}

function boundInt(flag, envVar, fallback) {
	const raw = arg(flag, process.env[envVar] || '');
	if (raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${flag} '${raw}'`);
	return value;
}

function main(mode, formatMode, framingMode) {
	const eventPath = arg('event', process.env.GITHUB_EVENT_PATH ?? '');
	if (!eventPath) throw new Error('no event payload (--event or GITHUB_EVENT_PATH)');
	const event = JSON.parse(readFileSync(eventPath, 'utf8'));
	const pr = event.pull_request;
	if (!pr) throw new Error('event payload has no pull_request');
	const liveAssociation = arg('pr-author-association', process.env.INPUT_PR_AUTHOR_ASSOCIATION || '').toUpperCase();
	if (liveAssociation && liveAssociation !== pr.author_association) {
		if (!AUTHOR_ASSOCIATIONS.has(liveAssociation)) {
			console.error(`::warning::review-coverage: ignoring unrecognized live author_association '${liveAssociation}'`);
		} else if (liveAssociation === 'MEMBER' || liveAssociation === 'OWNER') {
			console.log(
				`review-coverage: author_association resolved live as ${liveAssociation} (webhook payload had ${pr.author_association ?? 'unset'})`
			);
			pr.author_association = liveAssociation;
		} else {
			console.error(
				`::warning::review-coverage: ignoring non-promoting live author_association '${liveAssociation}' — this override can only promote to MEMBER/OWNER`
			);
		}
	}
	const rawRequired = arg('required', process.env.INPUT_REQUIRED || process.env.REVIEW_COVERAGE_REQUIRED || '');
	const required = rawRequired === '' ? COVERAGE_REQUIRED : Number(rawRequired);
	if (!Number.isInteger(required) || required < 0) throw new Error(`invalid required '${rawRequired}'`);
	const easy = {
		maxLines: boundInt('easy-max-lines', 'INPUT_EASY_MAX_LINES', EASY_MAX_LINES),
		maxFiles: boundInt('easy-max-files', 'INPUT_EASY_MAX_FILES', EASY_MAX_FILES),
	};
	const r = evaluateCiCoverage(pr, { mode, required, easy });
	let framingPaths = [];
	let framingConfigurationProblem = '';
	try {
		framingPaths = parseFramingPaths(arg('framing-paths', process.env.INPUT_FRAMING_PATHS || ''));
	} catch (error) {
		framingConfigurationProblem = `invalid framing configuration (${error instanceof Error ? error.message : String(error)})`;
	}
	const superseded = arg('pr-files-superseded', process.env.INPUT_PR_FILES_SUPERSEDED || '').toLowerCase() === 'true';
	let prFiles = null;
	let evidenceProblem = '';
	if (formatMode !== 'off' || framingPaths.length > 0) {
		try {
			prFiles = readPrFiles(superseded);
		} catch (error) {
			evidenceProblem = `PR-files evidence is unavailable (${error instanceof Error ? error.message : String(error)})`;
		}
	}
	const format = evaluatePrFormat(pr, {
		mode: formatMode,
		repo: String(event.repository?.full_name ?? ''),
		number: Number(event.number ?? pr.number),
		prFiles,
		evidenceProblem,
		superseded,
	});
	const framing = framingConfigurationProblem
		? {
				pass: framingMode !== 'enforce',
				compliant: false,
				exempt: '',
				detail: framingConfigurationProblem,
			}
		: evaluateFramingVerdict(pr, {
				mode: framingMode,
				paths: framingPaths,
				prFiles,
				evidenceProblem,
				superseded,
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
				: `Per team policy, a substantive AI-authored PR reports ${required} outside-model review families in its \`Review-Coverage:\` footer. Materialize it with the cross-model-review skill's \`pr-body-review-need.mjs --write\` (harper-engineering-guidelines, pr-conventions): it unions every review round the branch had, so the head commit does not need a receipt of its own — do not re-review just to produce the footer.`,
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
	if (framingPaths.length > 0 || framingConfigurationProblem) {
		lines.push(
			'',
			`### Framing verdict — ${framing.exempt ? '✅ exempt' : framing.compliant ? '✅' : framingMode === 'enforce' ? '❌' : '⚠️ report-only'}`,
			'',
			framing.exempt ? `_${framing.exempt}_` : framing.detail,
			'',
			'Configured core-shared paths require `Framing-Verdict: chosen-approach-sound`, or a non-clearing verdict recorded under `## For the human reviewer`.'
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
	if (framingPaths.length > 0 || framingConfigurationProblem)
		console.log(`framing-verdict [${framingMode}]: ${framing.exempt ? `exempt: ${framing.exempt}` : framing.detail}`);
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
	if (!framing.pass) {
		console.error(`::error::Framing verdict: ${framing.detail}`);
		process.exitCode = 1;
	} else if (!framing.compliant && !framing.exempt) {
		console.error(`::warning::Framing verdict: ${framing.detail}`);
	}
}

const mode = arg('mode', process.env.INPUT_MODE || process.env.REVIEW_COVERAGE_MODE || 'report').toLowerCase();
const formatMode = arg('format-mode', process.env.INPUT_FORMAT_MODE || 'off').toLowerCase();
const framingMode = arg('framing-mode', process.env.INPUT_FRAMING_MODE || 'report').toLowerCase();
if (!['report', 'enforce'].includes(mode)) {
	console.error(`::error::review-coverage: unknown mode '${mode}' (report|enforce)`);
	process.exitCode = 1;
} else if (!['off', 'report', 'enforce'].includes(formatMode)) {
	console.error(`::error::review-coverage: unknown format mode '${formatMode}' (off|report|enforce)`);
	process.exitCode = 1;
} else if (!['report', 'enforce'].includes(framingMode)) {
	console.error(`::error::review-coverage: unknown framing mode '${framingMode}' (report|enforce)`);
	process.exitCode = 1;
} else {
	try {
		main(mode, formatMode, framingMode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`review-coverage: ${message}${mode === 'enforce' || formatMode === 'enforce' || framingMode === 'enforce' ? '' : ' (passing — report mode fails only on policy)'}`
		);
		if (mode === 'enforce' || formatMode === 'enforce' || framingMode === 'enforce') {
			console.error(`::error::review-coverage could not evaluate this PR (${message}) — enforce mode fails closed`);
			process.exitCode = 1;
		}
	}
}
