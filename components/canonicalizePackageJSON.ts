/**
 * Canonicalize a parsed `package.json` for digesting or equality comparison: keys are sorted
 * everywhere except within the ROOT `exports`/`imports` fields' own condition maps, where Node
 * resolves conditions first-match (https://nodejs.org/api/packages.html#conditional-exports), so
 * reordering them can resolve to a different module and must not canonicalize equal.
 *
 * A subpath map's own keys (`.`, `./sub`, `#dep`) are matched by exact string or pattern
 * specificity, never by declaration order, so those keys are still sorted; only once inside a
 * subpath's value — where Node never nests another subpath map — does order become significant,
 * all the way down.
 */
export function canonicalizePackageJSON(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return canonicalize(value, false);
	const canonical: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(value).sort())
		canonical[key] =
			key === 'exports' || key === 'imports'
				? canonicalizeResolutionField((value as Record<string, unknown>)[key], key)
				: canonicalize((value as Record<string, unknown>)[key], false);
	return canonical;
}

function canonicalizeResolutionField(value: unknown, field: 'exports' | 'imports'): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item, true));
	if (!value || typeof value !== 'object') return value;
	const keys = Object.keys(value);
	// `imports` keys are always subpaths ("#dep"); at the `exports` root only a leading "." makes a
	// key a subpath — "#" there is a legal, if unusual, condition name (Node's own
	// isConditionalExportsMainSugar treats any non-"."-leading key as a condition).
	const isSubpathMap = field === 'imports' || keys.some((key) => key.startsWith('.'));
	const canonical: Record<string, unknown> = Object.create(null);
	for (const key of isSubpathMap ? keys.sort() : keys)
		canonical[key] = canonicalize((value as Record<string, unknown>)[key], true);
	return canonical;
}

function canonicalize(value: unknown, preserveOrder: boolean): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item, preserveOrder));
	if (!value || typeof value !== 'object') return value;
	const canonical: Record<string, unknown> = Object.create(null);
	const keys = preserveOrder ? Object.keys(value) : Object.keys(value).sort();
	for (const key of keys) canonical[key] = canonicalize((value as Record<string, unknown>)[key], preserveOrder);
	return canonical;
}
