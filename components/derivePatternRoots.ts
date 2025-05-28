/**
 * Derive the pattern roots from the list of patterns.
 *
 * @param patterns
 * @returns
 */
export function derivePatternRoots(patterns: string[]): Array<string> {
	const patternRoots = new Set<string>();

	for (const pattern of patterns) {
		const root = derivePatternRoot(pattern);
		if (root) patternRoots.add(root);
	}

	return Array.from(patternRoots);
}

export class InvalidPatternRootError extends Error {
	constructor(pattern: string) {
		super(`Pattern must not start with '/' nor contain '..'. Received: '${pattern}'`);
	}
}

/**
 * Derives longest, unambiguous paths from a pattern.
 *
 * The pattern should not have leading `/` or contain `..`.
 *
 * @param pattern
 * @returns
 */
export function derivePatternRoot(pattern: string) {
	if (pattern.startsWith('/') || pattern.includes('..')) {
		throw new InvalidPatternRootError(pattern);
	}

	pattern = pattern.replace(/^(\.\/)/, ''); // Remove leading `./` if present

	// If the input pattern is only `./` it would become '' in the previous step.
	if (pattern === '') return '.';

	const dynamicCharacter = ['*', '\\', '[', ']', '(', ')', '{', '}', '@', '!', '+', '?', '|', '^', '$'];
	let root: string = '';

	for (const c of pattern) {
		if (dynamicCharacter.includes(c)) {
			root = root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '.';
			break;
		}

		root += c;
	}

	return root.replace(/\/$/, '');
}
