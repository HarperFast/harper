/**
 * Canonicalize a parsed `package.json` (or any nested value within one) for digesting or
 * equality comparison. Keys are sorted everywhere EXCEPT inside `exports`/`imports`, where
 * declared key order is itself semantically significant: Node resolves conditions first-match
 * (https://nodejs.org/api/packages.html#conditional-exports), so two manifests that only reorder
 * conditions can resolve to different modules and must not canonicalize equal. That exemption
 * applies recursively to every condition map nested under `exports`/`imports`, including within
 * subpath and array entries.
 *
 * Shared by every runtime-equivalence comparison that treats `package.json` as parsed JSON
 * (components/RuntimeModuleTracker.ts, components/Application.ts) so the policy can't drift
 * between them the way two independent copies already had.
 */
export function canonicalizeJSON(value: unknown, preserveOrder = false): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalizeJSON(item, preserveOrder));
	if (!value || typeof value !== 'object') return value;
	const canonical: Record<string, unknown> = Object.create(null);
	const keys = preserveOrder ? Object.keys(value) : Object.keys(value).sort();
	for (const key of keys)
		canonical[key] = canonicalizeJSON(
			(value as Record<string, unknown>)[key],
			preserveOrder || key === 'exports' || key === 'imports'
		);
	return canonical;
}
