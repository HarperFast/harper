import { COVERAGE_REQUIRED, reportedCrossModelReviews, structuredCoverage } from './reviewGate.mjs';
import { stripFencedBlocks } from './prFormatLinks.mjs';
import { classifyPullRequest, easyDiffWaiver, isAiAuthored } from './prExemption.mjs';

/** `pass` in the return value already accounts for report versus enforce mode. */
export function evaluateCiCoverage(pr, { mode = 'report', required = COVERAGE_REQUIRED, easy = {} } = {}) {
	const body = String(pr?.body ?? '');
	// reviewGate.mjs is a vendored byte-identical copy and does not blank fenced blocks.
	const prose = stripFencedBlocks(body);
	const footers = prose.split('\n').filter((line) => /^[ \t]*(?:<sub>[ \t]*)?Review-Coverage:/i.test(line));
	// The LAST footer, matching the review-need read below: a body that appended a fresh round above
	// or below an older one must be scored on the current line, and `structuredCoverage` takes a
	// non-global exec, so it is handed that line rather than the whole body.
	const structured = footers.length ? structuredCoverage(footers.at(-1)) : null;
	// Report what is enforced: the summary and the gate must not read different lines.
	const { count, families } = structured ?? reportedCrossModelReviews(prose);
	// Only the receipt-derived footer is enforceable. Prose is written from memory, and cannot
	// exclude the authoring family when the body carries no generator signature.
	//
	// A footer with no recognized `authored=` cannot exclude that family either, so `ran=claude,codex`
	// would score two on a Claude-authored PR. Materialized footers always carry it.
	const enforceable = structured?.generator ? structured.count : 0;
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
		: structured.generator
			? ''
			: '; the `Review-Coverage:` footer names no `authored=` family, so it cannot exclude the authoring model and is not counted';
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
