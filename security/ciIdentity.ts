// No imports: the CLI loads this too.

export interface DesiredRole {
	role: string;
	permission: { super_user: false; operations: string[]; component_deploy?: unknown };
}

export interface DesiredUser {
	username: string;
	role: string;
}

export interface DesiredPolicy {
	id: string;
	issuer: string;
	audience: string;
	user: string;
	claims: Record<string, string>;
	operations: string[];
	description: string;
}

export interface DesiredIdentity {
	role: DesiredRole;
	user: DesiredUser;
	policies: DesiredPolicy[];
}

export type Reconcile = 'create' | 'keep';

export interface IdentityPlan {
	role: Reconcile;
	user: Reconcile;
	policies: Reconcile[];
	conflicts: string[];
}

const sameSet = (left: unknown, right: string[]) =>
	Array.isArray(left) && left.length === right.length && right.every((entry) => left.includes(entry));

const ROLE_FLAGS = new Set(['super_user', 'structure_user', 'cluster_user', 'operations', 'component_deploy']);

function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		rightKeys.every((key) => Object.hasOwn(left, key) && sameValue((left as any)[key], (right as any)[key]))
	);
}

/** A component grant's names are a set; its constraints are compared exactly. */
function sameGrant(existing: any, desired: any): boolean {
	if (existing === undefined || desired === undefined) return existing === desired;
	return (
		typeof existing === 'object' &&
		existing !== null &&
		sameSet(existing.names, desired.names) &&
		sameValue(existing.constraints, desired.constraints) &&
		Object.keys(existing).every((key) => key === 'names' || key === 'constraints')
	);
}

export function roleDifference(existing: any, desired: DesiredRole): string | undefined {
	const permission = existing?.permission ?? {};
	if (permission.super_user === true) return 'it is a super_user role';
	for (const flag of ['structure_user', 'cluster_user']) {
		if (permission[flag]) return `it sets ${flag}`;
	}
	if (!sameSet(permission.operations, desired.permission.operations)) {
		return `its operations are ${JSON.stringify(permission.operations ?? null)}, not ${JSON.stringify(desired.permission.operations)}`;
	}
	if (!sameGrant(permission.component_deploy, desired.permission.component_deploy)) {
		return `its component_deploy grant is ${JSON.stringify(permission.component_deploy ?? null)}, not ${JSON.stringify(desired.permission.component_deploy ?? null)}`;
	}
	const tableGrants = Object.keys(permission).filter((key) => !ROLE_FLAGS.has(key));
	if (tableGrants.length > 0) return `it grants database permissions (${tableGrants.join(', ')})`;
	return undefined;
}

export function userDifference(existing: any, desired: DesiredUser): string | undefined {
	const roleName = typeof existing?.role === 'object' ? existing.role?.role : existing?.role;
	if (roleName !== desired.role) return `it is in role "${roleName}", not "${desired.role}"`;
	if (existing.active === false) return 'it is inactive';
	return undefined;
}

export function policyDifferences(existing: any, desired: DesiredPolicy): string[] {
	const differences: string[] = [];
	for (const field of ['issuer', 'audience', 'user'] as const) {
		if (existing?.[field] !== desired[field]) {
			differences.push(`${field} is ${JSON.stringify(existing?.[field])}, not ${JSON.stringify(desired[field])}`);
		}
	}
	const claims = existing?.claims ?? {};
	const claimNames = new Set([...Object.keys(claims), ...Object.keys(desired.claims)]);
	for (const name of claimNames) {
		if (claims[name] !== desired.claims[name]) {
			differences.push(`claim ${name} is ${JSON.stringify(claims[name])}, not ${JSON.stringify(desired.claims[name])}`);
		}
	}
	if (!sameSet(existing?.operations, desired.operations)) {
		differences.push(
			`operations are ${JSON.stringify(existing?.operations ?? null)}, not ${JSON.stringify(desired.operations)}`
		);
	}
	if (existing?.enabled === false) differences.push('it is disabled');
	return differences;
}

export function planIdentityReconcile(
	existing: { roles: any[]; users: any[]; policies: any[] },
	desired: DesiredIdentity,
	replaceHint: (policyId: string) => string
): IdentityPlan {
	const conflicts: string[] = [];
	const role = existing.roles.find((candidate) => candidate?.role === desired.role.role);
	const roleProblem = role && roleDifference(role, desired.role);
	if (roleProblem) conflicts.push(`Role "${desired.role.role}" already exists and ${roleProblem}.`);

	const user = existing.users.find((candidate) => candidate?.username === desired.user.username);
	const userProblem = user && userDifference(user, desired.user);
	if (userProblem) conflicts.push(`User "${desired.user.username}" already exists and ${userProblem}.`);

	const policies = desired.policies.map((wanted): Reconcile => {
		const policy = existing.policies.find((candidate) => candidate?.id === wanted.id);
		const problems = policy ? policyDifferences(policy, wanted) : [];
		if (problems.length > 0) {
			conflicts.push(
				`Trust policy "${wanted.id}" already exists and ${problems.join('; ')}. ${replaceHint(wanted.id)}`
			);
		}
		return policy ? 'keep' : 'create';
	});
	return { role: role ? 'keep' : 'create', user: user ? 'keep' : 'create', policies, conflicts };
}

/**
 * Whether one token could match both policies: same issuer and audience, and for every claim both constrain, a value
 * both accept. The exchange takes the first match in id order, so two such policies leave which user a run acts as,
 * and with which operations, to the ids.
 */
export function policiesOverlap(left: any, right: any): boolean {
	if (left?.issuer !== right?.issuer || left?.audience !== right?.audience) return false;
	const leftClaims = left?.claims ?? {};
	const rightClaims = right?.claims ?? {};
	for (const name of Object.keys(leftClaims)) {
		if (!Object.hasOwn(rightClaims, name)) continue;
		const accepted = (value: unknown) => (Array.isArray(value) ? value : [value]).map(String);
		const rightValues = accepted(rightClaims[name]);
		if (!accepted(leftClaims[name]).some((value) => rightValues.includes(value))) return false;
	}
	return true;
}
