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
 * Derives non-ambiguous root paths from a pattern.
 *
 * The pattern should not have leading `/` or contain `..`
 *
 * @param pattern
 * @returns
 */
export function derivePatternRoot(pattern: string): string | null {
	if (pattern.startsWith('/') || pattern.includes('..')) {
		throw new InvalidPatternRootError(pattern);
	}

	if (['*', `./*`, '**', `./**`, `**/*`, `./**/*`].includes(pattern)) {
		return '/';
	}

	const ambiguousCharacters = ['\\', '[', ']', '(', ')', '{', '}', '@', '!', '+', '?', '|', '^', '$'];
	let root: string | null = '';

	for (const c of pattern) {
		if (ambiguousCharacters.includes(c)) {
			if (root.includes('/')) {
				root = root.slice(0, root.lastIndexOf('/') + 1);
			} else {
				root = null;
			}
			break;
		}

		if (c === '*') {
			if (!root.includes('/')) root = null;
			break;
		}

		root += c;
	}

	// static pattern of a file or directory
	if (root === pattern) {
		root = '/';
	}

	return root;
}
