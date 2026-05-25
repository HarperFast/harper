/**
 * Environment-variable expansion for config-loaded values.
 *
 * Harper's config parser does not expand `${VAR}` placeholders itself — the
 * `harperdb-config.yaml` value lands in memory verbatim. Component code that
 * needs to support env-var indirection (secrets, host overrides, etc.)
 * applies these helpers to its own config entries.
 *
 * The pattern matches the convention established by the OAuth component
 * (`@harperfast/oauth`'s `src/lib/config.ts`); kept identical so operator
 * documentation and config snippets carry over verbatim.
 *
 * Matching rules:
 * - Only **whole-string** `${VAR_NAME}` placeholders match. Partial expansion
 *   (e.g. `'http://${HOST}:9926'`) is NOT supported by design — keeps the
 *   substitution boundary unambiguous and avoids accidental injection into
 *   structured values.
 * - When the env var is undefined, the **original placeholder string is
 *   returned unchanged**. Callers detect missing values via downstream
 *   required-field checks (a `${VAR}` literal won't satisfy "non-empty string"
 *   contracts the same way a real key would).
 * - Non-string values pass through unchanged.
 */

/**
 * Single shared predicate. Both `expandEnvVar` and `isUnresolvedEnvVarPlaceholder`
 * must agree on what counts as a placeholder — otherwise an entry can sail past
 * one check and trip on the other, producing a confusing downstream error.
 *
 * A value qualifies when it's a whole-string `${VAR_NAME}` with no internal
 * whitespace (real shell env-var names disallow whitespace; rejecting it here
 * means `'${MY KEY}'` is treated as a literal value rather than a botched
 * lookup that always returns undefined).
 */
function looksLikePlaceholder(value: unknown): value is string {
	if (typeof value !== 'string' || !value.startsWith('${') || !value.endsWith('}')) return false;
	return !value.slice(2, -1).includes(' ');
}

/**
 * Expand a single value: returns `process.env[VAR_NAME]` if `value` is exactly
 * `${VAR_NAME}` and the env var is defined; returns `value` unchanged otherwise.
 *
 * @example
 * expandEnvVar('${OPENAI_API_KEY}') // process.env.OPENAI_API_KEY or '${OPENAI_API_KEY}' if unset
 * expandEnvVar('literal')           // 'literal'
 * expandEnvVar(123)                 // 123
 * expandEnvVar(undefined)           // undefined
 */
export function expandEnvVar<T>(value: T): T {
	if (looksLikePlaceholder(value)) {
		const envVar = value.slice(2, -1);
		const envValue = process.env[envVar];
		// Use the env value when defined (even if empty string — operators may
		// legitimately want to set an empty default).
		return (envValue !== undefined ? envValue : value) as T;
	}
	return value;
}

/**
 * Recursively expand `${VAR_NAME}` placeholders on every string leaf of a
 * value. Walks arrays and plain objects; bails on non-plain values.
 *
 * Used when a structured config block (e.g. `models.generative.<name>`) has
 * multiple string fields that may carry env-var placeholders, so callers
 * don't have to enumerate them.
 *
 * @example
 * expandEnvVarsDeep({ backend: 'openai', apiKey: '${OPENAI_API_KEY}' })
 * // → { backend: 'openai', apiKey: 'sk-...' }   (if env var set)
 */
export function expandEnvVarsDeep<T>(value: T): T {
	if (typeof value === 'string') {
		return expandEnvVar(value);
	}
	if (Array.isArray(value)) {
		return value.map(expandEnvVarsDeep) as unknown as T;
	}
	if (value !== null && typeof value === 'object') {
		// `Object.create(null)` avoids prototype-pollution gadgets via a
		// `__proto__` / `constructor` / `prototype` key. The YAML parser this
		// helper is initially used against produces plain objects without
		// these keys, but the helper is documented as reusable; defending
		// here makes "feed a JSON-from-HTTP payload through this" safe.
		const expanded = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			expanded[key] = expandEnvVarsDeep(item);
		}
		return expanded as T;
	}
	return value;
}

/**
 * Returns `true` when `value` is a literal `${VAR_NAME}` placeholder string —
 * i.e., a value that `expandEnvVar` would have substituted if the env var
 * were defined but didn't, leaving the original unchanged.
 *
 * Useful for distinguishing "operator wrote a literal placeholder by mistake"
 * (loud, surface to logs) from "operator set the value directly" (proceed).
 *
 * @example
 * isUnresolvedEnvVarPlaceholder('${OPENAI_API_KEY}') // true
 * isUnresolvedEnvVarPlaceholder('sk-real-key')        // false
 * isUnresolvedEnvVarPlaceholder('${FOO}-suffix')      // false (partial; not matched by expandEnvVar)
 */
export function isUnresolvedEnvVarPlaceholder(value: unknown): boolean {
	return looksLikePlaceholder(value);
}
