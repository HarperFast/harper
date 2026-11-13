/**
 * Translates a single glob pattern (only `*` is supported) into a regex.
 * `describe_*` matches `describe_schema`, `describe_table`, etc.; literals
 * like `system_information` match exactly. The glob language is deliberately
 * minimal to keep allow/deny lists predictable in audit/security reviews.
 */
export function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`);
}

export function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const p of patterns) {
		if (globToRegex(p).test(name)) return true;
	}
	return false;
}

/** A configured name list, or `undefined` when unset; non-string entries are dropped rather than thrown on mid-rebuild. */
export function readNameList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Compiles an allow/deny pair into a predicate. An unset or empty `allow` admits every name; `deny` is
 * applied after `allow`.
 */
export function compileNameFilter(
	allow: readonly string[] | undefined,
	deny: readonly string[] | undefined
): (name: string) => boolean {
	const allowPatterns = allow && allow.length > 0 ? allow.map(globToRegex) : undefined;
	const denyPatterns = deny && deny.length > 0 ? deny.map(globToRegex) : undefined;
	return (name) => {
		if (allowPatterns && !allowPatterns.some((pattern) => pattern.test(name))) return false;
		return !denyPatterns?.some((pattern) => pattern.test(name));
	};
}
