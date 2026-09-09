/**
 * GitHub Actions provider profile (#2171).
 *
 * The only module that should know anything about GitHub. Its rules are deliberately stricter than
 * npm's trusted-publishing model, and scoping them here means that strictness never constrains
 * another issuer.
 */

import { ClientError } from '../../../../utility/errors/hdbError.ts';
import type { ClaimConstraint, TokenClaims } from '../types.ts';
import type { IdentityProviderProfile } from './index.ts';

/**
 * Workflow references are `<owner>/<repo>/<path>@<ref>` and the ref is always a full `refs/...` name.
 * Splitting on `@refs/` rather than the first or last `@` is exact, because a path segment cannot
 * contain `/` — so this cannot occur inside the path, and a branch named `release@2` cannot fool it.
 */
const REF_QUALIFIER = '@refs/';

/**
 * GitHub's default audience is the repository owner's URL, shared by every repository under that
 * owner, so accepting it would make a token minted by any repo in the org valid here — the one
 * mistake the audience field exists to prevent.
 */
const SHARED_DEFAULT_AUDIENCE = /^https:\/\/github\.com\/[^/]+\/?$/i;

/**
 * Structural requirements on a policy's claim set, each guarding a distinct way a policy can be
 * accidentally broad. Satisfying none of a row's claims admits, in order: any repository, any
 * workflow in that repository, any branch that can be pushed to it.
 *
 * `repository_owner` is absent from the first row on purpose — it identifies an org, not a
 * repository, so it would admit every repo in the org. `ref_type` is absent from the third for the
 * same shape of reason: `ref_type: tag` still admits any tag, and anyone with push access can create
 * one. A tag-triggered release pins `environment` and leans on GitHub's environment protection.
 *
 * `job_workflow_ref` pins the workflow (second row) but deliberately does NOT gate the ref (third).
 * For a reusable workflow it names the workflow that RAN, not the caller that invoked it — the
 * caller's ref lives in `workflow_ref`/`ref`. Its `@ref` suffix therefore describes the reusable
 * workflow's own branch, which is constant however it is called, so accepting it as a ref gate would
 * admit any branch of any caller repository that references that reusable workflow: precisely the
 * hole the third row exists to close.
 *
 * `sub` is deliberately not accepted as a pin: it varies by trigger, and its format changed for
 * repositories created after 2026-07-15 (immutable subjects embed owner and repo ids).
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
		claims: ['workflow_ref', 'ref', 'environment'],
		because: ' — otherwise any branch that can be pushed to the repository can run the workflow and mint a token',
	},
];

/** Returns undefined rather than guessing when the value is not a ref-qualified reference. */
export function splitWorkflowPath(workflowRef: unknown): string | undefined {
	if (typeof workflowRef !== 'string') return undefined;
	const qualifierIndex = workflowRef.indexOf(REF_QUALIFIER);
	return qualifierIndex === -1 ? undefined : workflowRef.slice(0, qualifierIndex);
}

export const githubActionsProfile: IdentityProviderProfile = {
	name: 'GitHub Actions',

	assertPolicyIsSpecific(policyClaims: Record<string, ClaimConstraint>): void {
		const constrained = new Set(Object.keys(policyClaims));
		for (const { requirement, claims, because } of STRUCTURAL_REQUIREMENTS) {
			if (!claims.some((claimName) => constrained.has(claimName))) {
				throw new ClientError(`claims must ${requirement} with one of: ${claims.join(', ')}${because}`);
			}
		}
	},

	assertAudienceIsSpecific(audience: string): void {
		if (SHARED_DEFAULT_AUDIENCE.test(audience)) {
			throw new ClientError(
				`'audience' must identify this instance, not '${audience}' — GitHub's default audience is shared ` +
					`by every repository under an owner, so a token minted for any of them would be accepted here. ` +
					`Use the instance URL the CI client targets.`
			);
		}
	},

	/**
	 * Adds `workflow_path` / `job_workflow_path` — the workflow reference with the ref removed — so a
	 * policy can pin the workflow *file* while gating the ref some other way. A tag-triggered release
	 * cannot pin `workflow_ref`, because the tag is unknown when the policy is written.
	 *
	 * A claim the token actually carries is never displaced by one we synthesized.
	 */
	normalizeClaims(payload: TokenClaims): TokenClaims {
		const claims: TokenClaims = { ...payload };
		for (const [source, derived] of [
			['workflow_ref', 'workflow_path'],
			['job_workflow_ref', 'job_workflow_path'],
		]) {
			const path = splitWorkflowPath(payload[source]);
			if (path !== undefined && claims[derived] === undefined) claims[derived] = path;
		}
		return claims;
	},

	/**
	 * A `pull_request_target` run executes the base repository's workflow with its secrets while a
	 * fork controls the checked-out code. A plain `pull_request` run from a fork gets no
	 * `id-token: write` and so cannot mint at all, but `pull_request_target` can — so it is denied
	 * unless a policy constrains `event_name`, which is the explicit opt-in.
	 */
	vetoClaims(claims: TokenClaims, policyClaims: Record<string, ClaimConstraint>): string | undefined {
		if (claims.event_name === 'pull_request_target' && policyClaims.event_name === undefined) {
			return 'pull_request_target is denied unless the policy constrains event_name';
		}
		return undefined;
	},

	describePrincipal(claims: TokenClaims): string {
		return [
			claims.repository,
			claims.workflow_ref ?? claims.workflow_path,
			claims.environment && `environment=${claims.environment}`,
			claims.run_id && `run=${claims.run_id}`,
			claims.actor && `actor=${claims.actor}`,
		]
			.filter(Boolean)
			.join(' ');
	},
};
