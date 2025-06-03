export function deriveCommonPatternBase(patternBases: string[]): string {
	if (patternBases.length === 0) return '.';
	if (patternBases.length === 1) return patternBases[0];

	// Split each pattern root into segments
	// i.e. ['a/b/c', 'a/b/d'] -> [['a', 'b', 'c'], ['a', 'b', 'd']]
	const pathSegments = patternBases.map((path) => path.split('/'));
	// Find the minimum length of the segments
	const minSegments = Math.min(...pathSegments.map((segments) => segments.length));

	// Now to determine the common segments
	const commonSegments = [];
	// iterate up to the minimum segments length, this index is the part of the segments to compare
	for (let i = 0; i < minSegments; i++) {
		// Use the first path segment as a reference
		const segment = pathSegments[0][i];

		// Then iterate over all of the path segments and compare the segment at the current index
		if (pathSegments.every((segments) => segments[i] === segment)) {
			// If they all matched, its a common segment
			commonSegments.push(segment);
		} else {
			// Otherwise, there is a mismatch. Stop here
			break;
		}
	}

	// Now, inspect the common segments. If there are none, then use the root '.'
	// Otherwise, join the segments with '/' and that is the common root of the set of pattern roots.
	return commonSegments.length === 0 ? '.' : commonSegments.join('/');
}
