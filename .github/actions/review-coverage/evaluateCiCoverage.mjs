import { COVERAGE_REQUIRED, reportedCrossModelReviews } from './reviewGate.mjs';
import { classifyPullRequest } from './prExemption.mjs';

/** `pass` in the return value already accounts for report versus enforce mode. */
export function evaluateCiCoverage(pr, { mode = 'report', required = COVERAGE_REQUIRED } = {}) {
	const body = String(pr?.body ?? '');
	const { count, families } = reportedCrossModelReviews(body);
	const plural = count === 1 ? 'review' : 'reviews';
	const reported = `${count} cross-model ${plural} reported${families.length ? ` (${families.join(', ')})` : ''}`;
	const coverage = count >= required ? reported : `${reported} — policy asks for ${required}`;

	const footer = [
		...body.matchAll(/Human-Review-Need:\s*(\d+)(?:(?:(?!Human-Review-Need:)[^@\n])*@\s*([0-9a-f]{6,40}))?/gi),
	].at(-1);
	const head = String(pr?.head?.sha ?? '').toLowerCase();
	const footerNote = !footer
		? 'no Human-Review-Need footer'
		: !footer[2]
			? `Human-Review-Need: ${footer[1]} @ unpinned sha`
			: head.startsWith(footer[2].toLowerCase())
				? `Human-Review-Need: ${footer[1]} @ head`
				: `Human-Review-Need footer is STALE (reviewed @ ${footer[2].slice(0, 7)}, head is ${head.slice(0, 7)})`;

	const classification = classifyPullRequest(pr);
	const exempt = classification.exempt || (classification.draft ? 'draft — checked again at ready-for-review' : '');
	const compliant = count >= required;
	const pass = mode !== 'enforce' || Boolean(exempt) || compliant;
	const summary = exempt ? `exempt: ${exempt}` : coverage;
	return { pass, exempt, compliant, count, families, summary, detail: `${coverage}; ${footerNote}` };
}
