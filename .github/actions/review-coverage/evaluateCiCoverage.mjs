import { COVERAGE_REQUIRED, reportedCrossModelReviews, structuredCoverage } from './reviewGate.mjs';
import { stripFencedBlocks } from './prFormatLinks.mjs';
import { classifyPullRequest, easyDiffWaiver, isAiAuthored } from './prExemption.mjs';

// The exact output of `formatReviewCoverage` (HarperFast/skills-internal
// skills/cross-model-review/bin/prepush-policy.mjs), whose leg names come from REVIEW_LEGS there.
// A footer that helper could not have written was typed or edited by hand, so it grants no
// enforceable coverage. A well-formed forgery still passes: this checks shape, not receipts.
const COVERAGE_LEGS = new Set([
	'codex',
	'claude',
	'claude(fallback)',
	'gemini',
	'cursor-grok',
	'cursor-composer',
	'cursor-kimi',
	'cursor-muse',
]);
const RECEIPT_LEGS = new Set([...COVERAGE_LEGS, 'domain', 'conformance']);
const knownLegs = (key, allowed, legs) => {
	const unknown = legs.find((leg) => !allowed.has(leg));
	if (unknown !== undefined) return `names unknown leg \`${unknown}\` in \`${key}=\``;
	return new Set(legs).size === legs.length ? '' : `repeats a leg in \`${key}=\``;
};
const legList = (key, allowed) => (value) => knownLegs(key, allowed, value.split(','));
const positive = (key) => (value) =>
	/^[1-9]\d*$/.test(value) ? '' : `has \`${key}=${value}\`, not a positive integer`;
const SEGMENTS = new Map([
	[
		'authored',
		(value) =>
			/^(?:claude|codex|unknown)$/.test(value) ? '' : `has \`authored=${value}\`, not claude, codex or unknown`,
	],
	['ran', (value) => (value === 'none' ? '' : legList('ran', COVERAGE_LEGS)(value))],
	['adjudicated', legList('adjudicated', new Set(['domain']))],
	[
		'blocked',
		(value) => {
			const legs = [];
			for (const entry of value.split(',')) {
				const parsed = /^(.+)\(([^(),;@]+)\)$/.exec(entry);
				if (!parsed) return `has \`blocked=\` entry \`${entry}\`, not \`<leg>(<reason>)\``;
				legs.push(parsed[1]);
			}
			return knownLegs('blocked', RECEIPT_LEGS, legs);
		},
	],
	['declined', legList('declined', RECEIPT_LEGS)],
	['rounds', positive('rounds')],
	['full', positive('full')],
]);
const ORDER = [...SEGMENTS.keys()];
const FIELD = 'Review-Coverage: ';

export function coverageFooterProblem(line) {
	let field = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
	const opened = field.startsWith('<sub>');
	const closed = field.endsWith('</sub>');
	if (opened !== closed) return `has an unpaired \`${opened ? '<sub>' : '</sub>'}\``;
	if (opened) field = field.slice('<sub>'.length, -'</sub>'.length);
	if (!field.startsWith(FIELD)) return `does not begin \`${FIELD.trim()}\` followed by one space`;
	const pins = field.split('@').length - 1;
	if (pins === 0) return 'has no trailing ` @ <sha>` pin';
	if (pins > 1) return `carries ${pins} \`@\` pins where the helper writes one, at the end`;
	const [segmentText, sha] = field.slice(FIELD.length).split(' @ ');
	if (sha === undefined) return 'does not separate its pin as ` @ <sha>`';
	if (!/^[0-9a-f]{12}$/.test(sha)) return `is pinned to \`${sha}\`, not a 12-character lowercase hex sha`;
	const segments = segmentText.split('; ').map((segment) => {
		const split = segment.indexOf('=');
		return split < 0 ? [segment, undefined] : [segment.slice(0, split), segment.slice(split + 1)];
	});
	let previous = -1;
	for (const [key, value] of segments) {
		const position = ORDER.indexOf(key);
		if (position < 0 || value === undefined) return `has segment \`${key}\` the helper does not write`;
		if (position === previous) return `repeats \`${key}=\``;
		if (position < previous)
			return `has \`${key}=\` after \`${ORDER[previous]}=\`; the helper writes ${ORDER.join(', ')} in that order`;
		previous = position;
	}
	for (const required of ['authored', 'ran', 'rounds'])
		if (!segments.some(([key]) => key === required)) return `has no \`${required}=\` segment`;
	for (const [key, value] of segments) {
		const problem = SEGMENTS.get(key)(value);
		if (problem) return problem;
	}
	return '';
}

/** `pass` in the return value already accounts for report versus enforce mode. */
export function evaluateCiCoverage(pr, { mode = 'report', required = COVERAGE_REQUIRED, easy = {} } = {}) {
	const body = String(pr?.body ?? '');
	// reviewGate.mjs is a vendored byte-identical copy and does not blank fenced blocks.
	const prose = stripFencedBlocks(body);
	const footerLines = prose
		.split('\n')
		.flatMap((line, index) => (/^[ \t]*(?:<sub>[ \t]*)?Review-Coverage:/i.test(line) ? [index] : []));
	// The LAST footer, matching the review-need read below: a body that appended a fresh round above
	// or below an older one must be scored on the current line, and `structuredCoverage` takes a
	// non-global exec, so it is handed that line rather than the whole body. The line is read from
	// the unmasked body: masking blanks a trailing `<!-- -->` or inline code the grammar must see.
	const coverageLine = footerLines.length ? body.replace(/\r\n?/g, '\n').split('\n')[footerLines.at(-1)] : null;
	const structured = coverageLine === null ? null : structuredCoverage(coverageLine);
	const grammarProblem = coverageLine === null ? '' : coverageFooterProblem(coverageLine);
	// Report what is enforced: the summary and the gate must not read different lines.
	const { count, families } = structured ?? reportedCrossModelReviews(prose);
	// Only the receipt-derived footer is enforceable. Prose is written from memory, and cannot
	// exclude the authoring family when the body carries no generator signature.
	//
	// A footer with no recognized `authored=` cannot exclude that family either, so `ran=claude,codex`
	// would score two on a Claude-authored PR. Materialized footers always carry it.
	const enforceable = structured?.generator && !grammarProblem ? structured.count : 0;
	const plural = count === 1 ? 'review' : 'reviews';
	const reported = `${count} cross-model ${plural} reported${families.length ? ` (${families.join(', ')})` : ''}`;
	const coverage = count >= required ? reported : `${reported} — policy asks for ${required}`;

	const footer = [
		...prose.matchAll(/Human-Review-Need:\s*(\d+)(?:(?:(?!Human-Review-Need:)[^@\n])*@\s*([0-9a-f]{6,40}))?/gi),
	].at(-1);
	const head = String(pr?.head?.sha ?? '').toLowerCase();
	// Reported, never enforced: the question is whether two outside models looked at this change,
	// not whether the footer was re-materialized after the last amend.
	const footerNote = !footer
		? 'no Human-Review-Need footer'
		: !footer[2]
			? `Human-Review-Need: ${footer[1]} @ unpinned sha`
			: head.startsWith(footer[2].toLowerCase())
				? `Human-Review-Need: ${footer[1]} @ head`
				: `Human-Review-Need footer is stale (reviewed @ ${footer[2].slice(0, 7)}, head is ${head.slice(0, 7)})`;

	const classification = classifyPullRequest(pr);
	const waiver = easyDiffWaiver(pr, easy);
	const aiAuthored = isAiAuthored(prose);
	// Waives ONE leg, not "all but one": a consumer asking for three still gets two.
	const easyWaived = waiver.waived && enforceable >= Math.max(1, required - 1);
	const exempt =
		classification.exempt ||
		(classification.draft ? 'draft — checked again at ready-for-review' : '') ||
		(!aiAuthored ? 'not AI-authored — coverage is reported, not required' : '') ||
		(easyWaived ? `Complexity: easy on a ${waiver.lines}-line diff — one outside review is enough` : '');
	const compliant = enforceable >= required;
	const pass = mode !== 'enforce' || Boolean(exempt) || compliant;
	const proseNote = !structured
		? count > 0
			? '; coverage is prose-only — only the `Review-Coverage:` footer is counted for enforcement'
			: ''
		: !structured.generator
			? '; the `Review-Coverage:` footer names no `authored=` family, so it cannot exclude the authoring model and is not counted'
			: grammarProblem
				? `; the \`Review-Coverage:\` footer ${grammarProblem}, which the helper never writes, so it is typed or hand-edited and counts 0 toward enforcement — re-materialize it with \`pr-body-review-need.mjs --write\``
				: '';
	const easyNote =
		waiver.claimed && !waiver.waived ? `; \`Complexity: easy\` does not waive here — ${waiver.reason}` : '';
	const summary = exempt ? `exempt: ${exempt}` : coverage;
	return {
		pass,
		exempt,
		compliant,
		count,
		families,
		aiAuthored,
		summary,
		detail: `${coverage}; ${footerNote}${easyNote}${proseNote}`,
	};
}
