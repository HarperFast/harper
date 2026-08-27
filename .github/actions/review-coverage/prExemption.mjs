import { isTrivialChange } from './reviewGate.mjs';

const NON_MEMBER_ASSOCIATIONS = new Set([
	'COLLABORATOR',
	'CONTRIBUTOR',
	'FIRST_TIME_CONTRIBUTOR',
	'FIRST_TIMER',
	'MANNEQUIN',
	'NONE',
]);

export function classifyPullRequest(pr) {
	const login = String(pr?.user?.login ?? '');
	const association = String(pr?.author_association ?? '');
	const sized = Number.isFinite(pr?.additions) && Number.isFinite(pr?.deletions);
	const exempt =
		login.endsWith('[bot]') || pr?.user?.type === 'Bot'
			? 'bot author'
			: NON_MEMBER_ASSOCIATIONS.has(association)
				? `author is not an org member (${association}) — always human review`
				: sized && isTrivialChange(pr.additions, pr.deletions)
					? 'trivial change (≤2 lines)'
					: '';
	return { exempt, draft: Boolean(pr?.draft), sized };
}
