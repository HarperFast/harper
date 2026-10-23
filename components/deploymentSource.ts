// Where a deploy came from (#3061): the commit, the CI run and the trust policy, recorded on its deployment row as
// `source`. `via: 'oidc'` is attested: the OIDC exchange verified the identity token's claims and signed them into the
// operation token it minted (security/credentialProvenance.ts). `via: 'declared'` is what the client said about
// itself, so a reader can tell the two apart.

/** The identity token claims an attested source carries, in GitHub's names; another issuer supplies what it has. */
export const SOURCE_FIELDS = [
	'repository',
	'sha',
	'ref',
	'workflow_ref',
	'run_id',
	'run_attempt',
	'actor',
	'environment',
] as const;

const MAX_FIELD_LENGTH = 512;

export interface DeploymentSource {
	via: 'oidc' | 'declared';
	policy?: string;
	dirty?: boolean;
	[field: string]: unknown;
}

function pickFields(from: Record<string, unknown>, into: Record<string, unknown>): void {
	for (const field of SOURCE_FIELDS) {
		const value = from[field];
		if ((typeof value === 'string' && value.length > 0) || typeof value === 'number')
			into[field] = String(value).slice(0, MAX_FIELD_LENGTH);
	}
}

/** The attested source a verified exchange signs into its operation token. */
export function attestedSource(policyId: string, claims: Record<string, unknown>): DeploymentSource {
	const source: DeploymentSource = { via: 'oidc', policy: policyId };
	pickFields(claims, source);
	return source;
}

/** A signed claim read back off a verified token; anything else it might hold is dropped. */
export function readAttestedSource(claim: unknown): DeploymentSource | undefined {
	if (!claim || typeof claim !== 'object' || (claim as any).via !== 'oidc' || typeof (claim as any).policy !== 'string')
		return undefined;
	return attestedSource((claim as any).policy, claim as Record<string, unknown>);
}

/**
 * The source a deploy records: attested when its caller authenticated through an OIDC exchange, which wins over
 * anything the request declares; otherwise whatever it declared, marked as such; otherwise none.
 */
export function deploymentSource(attested: unknown, declared: unknown): DeploymentSource | null {
	const verified = readAttestedSource(attested);
	if (verified) return verified;
	if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return null;
	const source: DeploymentSource = { via: 'declared' };
	pickFields(declared as Record<string, unknown>, source);
	if (typeof (declared as any).dirty === 'boolean') source.dirty = (declared as any).dirty;
	return Object.keys(source).length > 1 ? source : null;
}
