import { stripCodePlaceholders, stripFencedBlocks } from './prFormatLinks.mjs';

const MEMBER_ASSOCIATIONS = new Set(['MEMBER', 'OWNER']);
const VERDICT_VALUES = new Set(['chosen-approach-sound', 'better-alternative-exists', 'option-set-too-narrow']);
const VERDICT_FIELD =
	/^[ \t]*(?:<sub>[ \t]*)?Framing-Verdict[ \t]*:[ \t]*(chosen-approach-sound|better-alternative-exists|option-set-too-narrow)(?:[ \t]+\((?:[0-9a-f]{12}|round roll-up)\))?[ \t]*(?:<\/sub>)?[ \t]*$/gim;
const REVIEWER_SECTION = /^##[ \t]+For the human reviewer[ \t]*$/i;
const H2_HEADING = /^##[ \t]+.*$/gm;

export function parseFramingPaths(value) {
	const paths = [];
	for (const rawLine of String(value ?? '')
		.replace(/\r/g, '')
		.split('\n')) {
		const pattern = rawLine.trim();
		if (!pattern) continue;
		const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
		if (
			!prefix ||
			prefix.startsWith('/') ||
			prefix.startsWith('./') ||
			prefix.endsWith('/') ||
			prefix.split('/').some((part) => !part || part === '.' || part === '..') ||
			/[*?\\]/.test(prefix)
		)
			throw new Error(`invalid framing path '${pattern}' (use an exact repository path or directory/**)`);
		paths.push(pattern);
	}
	return [...new Set(paths)];
}

function matchesPattern(filePath, pattern) {
	if (pattern.endsWith('/**')) {
		const prefix = pattern.slice(0, -3);
		return filePath.startsWith(`${prefix}/`);
	}
	return filePath === pattern;
}

export function matchingFramingPaths(prFiles, patterns) {
	const matches = [];
	for (const file of prFiles?.files ?? []) {
		for (const filePath of [file.path, file.previousPath]) {
			if (filePath && patterns.some((pattern) => matchesPattern(filePath, pattern))) matches.push(filePath);
		}
	}
	return [...new Set(matches)];
}

function framingExemption(pr) {
	const login = String(pr?.user?.login ?? '');
	if (pr?.draft) return 'draft — checked again at ready-for-review';
	if (login.endsWith('[bot]') || pr?.user?.type === 'Bot') return 'bot author — route through human review';
	const association = String(pr?.author_association ?? '');
	if (!MEMBER_ASSOCIATIONS.has(association))
		return `author is not an org member (${association || 'unknown'}) — route through human review`;
	return '';
}

function reviewerSections(prose) {
	const headings = [...prose.matchAll(H2_HEADING)];
	return headings
		.map((heading, index) => ({
			heading: heading[0],
			start: heading.index + heading[0].length,
			end: headings[index + 1]?.index ?? prose.length,
		}))
		.filter(({ heading }) => REVIEWER_SECTION.test(heading))
		.map((section) => ({ ...section, content: prose.slice(section.start, section.end) }));
}

function disagreementProblem(prose, verdictMatches) {
	const sections = reviewerSections(prose);
	for (const verdict of verdictMatches.filter((match) => match[1].toLowerCase() !== 'chosen-approach-sound')) {
		const value = verdict[1].toLowerCase();
		const section = sections.find(({ start, end }) => verdict.index >= start && verdict.index < end);
		if (!section) return `${value} must be recorded inside ## For the human reviewer`;
		const explanation = stripCodePlaceholders(section.content.replace(VERDICT_FIELD, ''))
			.replace(/<[^>]+>/g, '')
			.trim();
		if (!explanation) return `## For the human reviewer needs an explanation for ${value}`;
	}
	return '';
}

export function evaluateFramingVerdict(
	pr,
	{ mode = 'report', paths = [], prFiles = null, evidenceProblem = '', superseded = false } = {}
) {
	if (paths.length === 0)
		return { pass: true, exempt: 'no framing paths configured', compliant: true, matchedPaths: [], verdicts: [] };
	if (superseded)
		return { pass: true, exempt: 'superseded by a newer PR head', compliant: true, matchedPaths: [], verdicts: [] };
	const exempt = framingExemption(pr);
	if (exempt) return { pass: true, exempt, compliant: true, matchedPaths: [], verdicts: [] };

	const evidenceIssue = evidenceProblem || (!prFiles ? 'PR-files evidence is unavailable' : '');
	if (evidenceIssue)
		return {
			pass: mode !== 'enforce',
			exempt: '',
			compliant: false,
			matchedPaths: [],
			verdicts: [],
			detail: `${evidenceIssue}; cannot determine whether a framing-required path changed`,
		};

	const matchedPaths = matchingFramingPaths(prFiles, paths);
	if (matchedPaths.length === 0) {
		if (!prFiles.complete)
			return {
				pass: mode !== 'enforce',
				exempt: '',
				compliant: false,
				matchedPaths,
				verdicts: [],
				detail: 'PR-files evidence is incomplete; cannot rule out a framing-required path',
			};
		return {
			pass: true,
			exempt: '',
			compliant: true,
			matchedPaths,
			verdicts: [],
			detail: 'no framing-required path changed',
		};
	}

	const prose = stripFencedBlocks(String(pr?.body ?? ''));
	const verdictMatches = [...prose.matchAll(VERDICT_FIELD)].filter((match) =>
		VERDICT_VALUES.has(match[1].toLowerCase())
	);
	const verdicts = verdictMatches.map((match) => match[1].toLowerCase());
	const reviewerProblem = disagreementProblem(prose, verdictMatches);
	const compliant = verdicts.length > 0 && !reviewerProblem;
	const matched = matchedPaths[0];
	const detail =
		verdicts.length === 0
			? `${matched} requires Framing-Verdict: chosen-approach-sound, or a recorded non-clearing verdict`
			: reviewerProblem
				? `${matched} carries ${reviewerProblem}`
				: `${matched} has an accepted framing verdict (${verdicts.join(', ')})`;
	return {
		pass: mode !== 'enforce' || compliant,
		exempt: '',
		compliant,
		matchedPaths,
		verdicts,
		detail,
	};
}
