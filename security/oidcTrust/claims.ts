/**
 * Claim normalization, matching, and policy validation for OIDC trusted publishing (#2171).
 *
 * Pure — no network, no storage — so the rules that decide whether an external CI run may act as a
 * Harper user can be exercised directly.
 */

import { ClientError } from '../../utility/errors/hdbError.ts';
import type { ClaimConstraint, TokenClaims } from './types.ts';

/**
 * Workflow references are `<owner>/<repo>/<path>@<ref>` and the ref is always a full `refs/...` name.
 * Splitting on `@refs/` rather than the first or last `@` is exact, because a path segment cannot
 * contain `/` — so this cannot occur inside the path, and a branch named `release@2` cannot fool it.
 */
const REF_QUALIFIER = '@refs/';

/**
 * Structural requirements on a policy's claim set, each guarding a distinct way a policy can be
 * accidentally broad. Satisfying none of a row's claims admits, in order: any repository, any
 * workflow in that repository, any branch that can be pushed to it.
 *
 * `repository_owner` is absent from the first row on purpose — it identifies an org, not a
 * repository, so it would admit every repo in the org. `ref_type` is absent from the third for the
 * same shape of reason: `ref_type: tag` still admits any tag, and anyone with push access can create
 * one. A tag-triggered release pins `environment` and leans on the provider's environment protection.
 */
const STRUCTURAL_REQUIREMENTS = [
	{
		requirement: 'pin the repository',
		claims: ['repository_id', 'repository'],
		because: ' (repository_id is immutable and survives renames)',
	},
	{
		requirement: 'pin the workflow',
		claims: ['workflow_ref', 'workflow_path', 'job_workflow_ref', 'job_workflow_path'],
		because: '',
	},
	{
		requirement: 'gate the ref',
		claims: ['workflow_ref', 'job_workflow_ref', 'ref', 'environment'],
		because: ' — otherwise any branch that can be pushed to the repository can run the workflow and mint a token',
	},
];

/** Returns undefined rather than guessing when the value is not a ref-qualified reference. */
export function splitWorkflowPath(workflowRef: unknown): string | undefined {
	if (typeof workflowRef !== 'string') return undefined;
	const qualifierIndex = workflowRef.indexOf(REF_QUALIFIER);
	return qualifierIndex === -1 ? undefined : workflowRef.slice(0, qualifierIndex);
}

/**
 * Adds `workflow_path` / `job_workflow_path` — the workflow reference with the ref removed — so a
 * policy can pin the workflow *file* while gating the ref some other way. A tag-triggered release
 * cannot pin `workflow_ref`, because the tag is unknown when the policy is written.
 *
 * A claim the token actually carries is never displaced by one we synthesized.
 */
export function normalizeTokenClaims(payload: TokenClaims): TokenClaims {
	const claims: TokenClaims = { ...payload };
	for (const [source, derived] of [
		['workflow_ref', 'workflow_path'],
		['job_workflow_ref', 'job_workflow_path'],
	]) {
		const path = splitWorkflowPath(payload[source]);
		if (path !== undefined && claims[derived] === undefined) claims[derived] = path;
	}
	return claims;
}

/** Issuers may encode a numeric id as a JSON number; anything non-scalar is not comparable. */
function claimToString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

/**
 * Returns undefined on a match, or the first failure's reason — for the log, never the caller.
 *
 * A constrained claim absent from the token fails rather than passes, so a policy cannot be weakened
 * by an issuer that stops emitting a claim.
 */
export function matchTrustPolicyClaims(
	claims: TokenClaims,
	policyClaims: Record<string, ClaimConstraint>
): string | undefined {
	const constraints = Object.entries(policyClaims);
	// validateTrustPolicyClaims rejects this at write time; this backstops a row that reached the
	// table another way, such as replication from a peer.
	if (constraints.length === 0) return 'policy constrains no claims';

	for (const [claimName, constraint] of constraints) {
		const actual = claimToString(claims[claimName]);
		if (actual === undefined || actual === '') return `token has no usable ${claimName} claim`;
		const accepted = Array.isArray(constraint) ? constraint : [constraint];
		if (!accepted.includes(actual)) return `${claimName} does not match the policy`;
	}
	return undefined;
}

/** Throws ClientError naming the first problem; the reader is an administrator writing a policy. */
export function validateTrustPolicyClaims(
	policyClaims: unknown
): asserts policyClaims is Record<string, ClaimConstraint> {
	if (!policyClaims || typeof policyClaims !== 'object' || Array.isArray(policyClaims)) {
		throw new ClientError('claims must be an object of claim constraints');
	}

	const entries = Object.entries(policyClaims as Record<string, unknown>);
	if (entries.length === 0) throw new ClientError('claims must constrain at least one claim');

	for (const [claimName, constraint] of entries) {
		const values = Array.isArray(constraint) ? constraint : [constraint];
		if (values.length === 0) throw new ClientError(`claims.${claimName} must accept at least one value`);
		for (const value of values) {
			if (typeof value !== 'string' || value === '') {
				throw new ClientError(`claims.${claimName} must be a non-empty string or an array of non-empty strings`);
			}
		}
	}

	const constrained = new Set(entries.map(([claimName]) => claimName));
	for (const { requirement, claims, because } of STRUCTURAL_REQUIREMENTS) {
		if (!claims.some((claimName) => constrained.has(claimName))) {
			throw new ClientError(`claims must ${requirement} with one of: ${claims.join(', ')}${because}`);
		}
	}
}
