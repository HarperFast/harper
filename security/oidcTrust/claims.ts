/**
 * Claim normalization, matching, and policy validation for OIDC trusted publishing (#2171).
 *
 * Pure — no network, no storage — so the rules that decide whether an external CI run may act as a
 * Harper user can be exercised directly.
 */

import { ClientError } from '../../utility/errors/hdbError.ts';
import type { ClaimConstraint, TokenClaims } from './types.ts';

/**
 * A ref-qualified workflow reference is `<owner>/<repo>/<path>@<ref>`, and the ref is always a full
 * `refs/...` name. Splitting on `@refs/` rather than the first or last `@` is exact: a path segment
 * cannot contain `/`, so `@refs/` cannot occur inside the path portion.
 */
const REF_QUALIFIER = '@refs/';

/**
 * Claims that pin *which repository* minted the token. `repository_id` is an immutable numeric id:
 * it survives renames and cannot be re-acquired by a new owner of a recycled org name, so it is the
 * pin to prefer. `repository_owner` is deliberately absent — it identifies an org, not a repository,
 * and would let any repo in the org match.
 */
export const REPOSITORY_PIN_CLAIMS = ['repository_id', 'repository'];

/** Claims that pin *which workflow file* ran. */
export const WORKFLOW_PIN_CLAIMS = ['workflow_ref', 'workflow_path', 'job_workflow_ref', 'job_workflow_path'];

/**
 * Claims that pin the run to a specific ref, or to an environment whose protection rules gate it.
 * Without one of these, any branch that can be pushed to the repository can run the trusted workflow
 * and mint a token — the weakness in trusting repository + workflow filename alone.
 *
 * `ref_type` is not here on purpose: `ref_type: tag` still admits any tag, which anyone with push
 * access can create. A tag-triggered release should pin `environment` and lean on GitHub's
 * environment protection (required reviewers, tag deployment rules) for the gate.
 */
export const REF_GATE_CLAIMS = ['workflow_ref', 'job_workflow_ref', 'ref', 'environment'];

/**
 * Splits the ref off a workflow reference, yielding the workflow path alone. Returns undefined when
 * the value isn't a ref-qualified reference, so a caller never matches against a guess.
 */
export function splitWorkflowPath(workflowRef: unknown): string | undefined {
	if (typeof workflowRef !== 'string') return undefined;
	const qualifierIndex = workflowRef.indexOf(REF_QUALIFIER);
	return qualifierIndex === -1 ? undefined : workflowRef.slice(0, qualifierIndex);
}

/**
 * Adds derived claims to a verified token's payload.
 *
 * `workflow_path` / `job_workflow_path` are the workflow reference with the ref removed. They exist
 * so a policy can pin the workflow *file* while gating the ref some other way — a tag-triggered
 * release cannot pin `workflow_ref`, because the tag is not known when the policy is written.
 *
 * Derived entries are computed last so a claim actually present in the token cannot be displaced by
 * one we synthesized.
 */
export function normalizeTokenClaims(payload: TokenClaims): TokenClaims {
	const claims: TokenClaims = { ...payload };
	const workflowPath = splitWorkflowPath(payload.workflow_ref);
	const jobWorkflowPath = splitWorkflowPath(payload.job_workflow_ref);
	if (workflowPath !== undefined && claims.workflow_path === undefined) claims.workflow_path = workflowPath;
	if (jobWorkflowPath !== undefined && claims.job_workflow_path === undefined) {
		claims.job_workflow_path = jobWorkflowPath;
	}
	return claims;
}

/**
 * Claim values arrive as strings, but an issuer is free to encode a numeric id as a JSON number.
 * Anything else (boolean, object, array, null) is not a value we will compare.
 */
function claimToString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

/**
 * Matches normalized token claims against a policy's constraints. Returns undefined on a match, or a
 * short reason for the first failure — for the log, not for the caller: a client that learns *which*
 * constraint failed can enumerate a policy one claim at a time.
 *
 * Every constraint must be satisfied, and a constrained claim that is absent from the token is a
 * failure rather than a pass, so a policy cannot be weakened by an issuer dropping a claim.
 */
export function matchTrustPolicyClaims(
	claims: TokenClaims,
	policyClaims: Record<string, ClaimConstraint>
): string | undefined {
	const constraints = Object.entries(policyClaims);
	// A policy with no constraints would match every token from the issuer. validateTrustPolicyClaims
	// rejects that at write time; this is the matching-side backstop for a policy stored before (or
	// around) that validation.
	if (constraints.length === 0) return 'policy constrains no claims';

	for (const [claimName, constraint] of constraints) {
		const actual = claimToString(claims[claimName]);
		if (actual === undefined || actual === '') return `token has no usable ${claimName} claim`;
		const accepted = Array.isArray(constraint) ? constraint : [constraint];
		if (!accepted.includes(actual)) return `${claimName} does not match the policy`;
	}
	return undefined;
}

function describeUnpinned(claimNames: string[]): string {
	return claimNames.join(', ');
}

/**
 * Validates a policy's claim constraints at write time. Throws ClientError describing the first
 * problem; the caller is an administrator, so these messages are meant to be read.
 *
 * The three structural requirements exist because each guards a distinct way a policy can be
 * accidentally broad: no repository pin admits any repository, no workflow pin admits any workflow
 * in the repository, and no ref gate admits any branch that can be pushed.
 */
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
	if (!REPOSITORY_PIN_CLAIMS.some((claimName) => constrained.has(claimName))) {
		throw new ClientError(
			`claims must pin the repository with one of: ${describeUnpinned(REPOSITORY_PIN_CLAIMS)} (repository_id is immutable and survives renames)`
		);
	}
	if (!WORKFLOW_PIN_CLAIMS.some((claimName) => constrained.has(claimName))) {
		throw new ClientError(`claims must pin the workflow with one of: ${describeUnpinned(WORKFLOW_PIN_CLAIMS)}`);
	}
	if (!REF_GATE_CLAIMS.some((claimName) => constrained.has(claimName))) {
		throw new ClientError(
			`claims must gate the ref with one of: ${describeUnpinned(REF_GATE_CLAIMS)} — otherwise any branch that can be pushed to the repository can run the workflow and mint a token`
		);
	}
}
