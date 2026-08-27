import { classifyPullRequest } from './prExemption.mjs';
import { checkBodyLinks, inspectBodyText } from './prFormatLinks.mjs';

const MAX_BODY_LENGTH = 65_536;

function matches(prose, pattern) {
	return [...prose.matchAll(pattern)];
}

export function evaluatePrFormat(pr, { mode = 'report', repo, number, prFiles = null, evidenceProblem = '' } = {}) {
	const classification = classifyPullRequest(pr);
	if (mode === 'off' || classification.exempt)
		return {
			pass: true,
			exempt: mode === 'off' ? 'format check disabled' : classification.exempt,
			compliant: true,
			problems: [],
		};

	const body = String(pr?.body ?? '');
	const inspected = inspectBodyText(body);
	const prose = inspected.prose;
	const problems = [];
	if (body.length > MAX_BODY_LENGTH) problems.push(`description exceeds ${MAX_BODY_LENGTH} characters`);
	if (inspected.unterminatedFence) problems.push('description has an unterminated fenced code block');
	const firstHeading = prose.search(/^##\s+/m);
	const summary = (firstHeading < 0 ? prose : prose.slice(0, firstHeading)).replace(/<[^>]+>/g, '').trim();
	if (!summary) problems.push('description needs summary prose before its sections');

	const verification = matches(prose, /^## Verification\s*$/gim);
	if (verification.length !== 1)
		problems.push(`description needs exactly one ## Verification section (found ${verification.length})`);
	else {
		const content = prose
			.slice(verification[0].index + verification[0][0].length)
			.split(/^(?:##\s+|Complexity:|\s*<sub>(?:Review-Coverage:|Human-Review-Need:))/m)[0]
			.trim();
		if (!content) problems.push('## Verification needs executed evidence or a not-observable rationale');
	}

	const links = checkBodyLinks({ body, prFiles, repo, number });
	problems.push(...links.problems.map(({ message }) => message));
	const aiMarkers = /^(?:Complexity:|\s*(?:<sub>)?(?:Review-Coverage:|Human-Review-Need:))/m.test(prose);
	if (aiMarkers) {
		const reviewer = matches(prose, /^## For the human reviewer\s*$/gim);
		if (reviewer.length !== 1)
			problems.push(
				`AI-shaped description needs exactly one ## For the human reviewer section (found ${reviewer.length})`
			);
		else if (verification.length === 1 && reviewer[0].index > verification[0].index)
			problems.push('## For the human reviewer must precede ## Verification');
		else {
			const content = prose
				.slice(reviewer[0].index + reviewer[0][0].length)
				.split(/^##\s+/m)[0]
				.trim();
			if (!content)
				problems.push('## For the human reviewer needs a decision ledger or the no-open-judgment-calls statement');
		}
		const complexityFields = matches(prose, /^Complexity:/gim);
		const complexity = matches(prose, /^Complexity:\s*(easy|medium|complicated)\s*$/gim);
		if (complexityFields.length !== 1 || complexity.length !== 1)
			problems.push(
				`AI-shaped description needs exactly one valid Complexity field (found ${complexityFields.length})`
			);
		const coverageFields = matches(prose, /^\s*(?:<sub>)?Review-Coverage:/gm);
		const coverage = matches(prose, /^\s*<sub>Review-Coverage:[^\n]*@\s*[0-9a-f]{6,40}<\/sub>\s*$/gim);
		if (coverageFields.length !== 1 || coverage.length !== 1)
			problems.push(
				`AI-shaped description needs exactly one pinned Review-Coverage footer (found ${coverageFields.length})`
			);
		const needFields = matches(prose, /^\s*(?:<sub>)?Human-Review-Need:/gm);
		const need = matches(prose, /^\s*<sub>Human-Review-Need:\s*[0-4]\s*@\s*[0-9a-f]{6,40}<\/sub>\s*$/gim);
		if (needFields.length !== 1 || need.length !== 1)
			problems.push(
				`AI-shaped description needs exactly one pinned Human-Review-Need footer (found ${needFields.length})`
			);
		const head = String(pr?.head?.sha ?? '').toLowerCase();
		for (const [label, field] of [
			['Review-Coverage', coverage[0]],
			['Human-Review-Need', need[0]],
		]) {
			const pin = field?.[0].match(/@\s*([0-9a-f]{6,40})<\/sub>/i)?.[1].toLowerCase();
			if (pin && !head.startsWith(pin)) problems.push(`${label} footer is not pinned to the current head`);
		}
		if (
			verification.length === 1 &&
			complexity.length === 1 &&
			coverage.length === 1 &&
			need.length === 1 &&
			!(
				verification[0].index < complexity[0].index &&
				complexity[0].index < coverage[0].index &&
				coverage[0].index < need[0].index
			)
		)
			problems.push('AI fields must follow Verification in Complexity, Review-Coverage, Human-Review-Need order');
	}

	if (links.unverifiable) problems.push('current PR-diff links could not be fully verified');
	if (evidenceProblem) problems.push(evidenceProblem);
	const compliant = problems.length === 0;
	return {
		pass: mode !== 'enforce' || classification.draft || compliant,
		exempt: '',
		draft: classification.draft,
		compliant,
		problems,
		links,
	};
}
