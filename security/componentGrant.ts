/**
 * A role's component grant: `deploy_component`, `drop_component`, `get_deployment` and
 * `list_deployments` for the components whose names match its patterns, and `get_components` filtered to them.
 *
 * ```yaml
 * permission:
 *   component_deploy:
 *     names: ['shop-pr-*']
 *     constraints:
 *       isolated: true
 *       hostSuffix: .shop.example.com
 *       branchedDatabases: required
 * ```
 *
 * Where each part is enforced, and why: security/DESIGN.md.
 */
import { componentNameMatches, isComponentNamePattern } from '../utility/componentNames.ts';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';

export const COMPONENT_GRANT_KEY = 'component_deploy';

export const COMPONENT_GRANT_OPERATIONS: ReadonlySet<string> = new Set([
	OPERATIONS_ENUM.DEPLOY_COMPONENT,
	OPERATIONS_ENUM.DROP_COMPONENT,
	OPERATIONS_ENUM.GET_DEPLOYMENT,
	OPERATIONS_ENUM.LIST_DEPLOYMENTS,
	OPERATIONS_ENUM.GET_COMPONENTS,
]);

export interface ComponentGrantConstraints {
	isolated?: true;
	hostSuffix?: string;
	branchedDatabases?: 'required';
}

export interface ComponentGrant {
	names: string[];
	constraints?: ComponentGrantConstraints;
}

/** The routing a deploy would publish, as far as a grant's constraints read it. */
export interface PublishedRouting {
	isolated?: unknown;
	host?: unknown;
	branchedDatabases?: unknown;
}

const HOST_SUFFIX = /^(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const CONSTRAINT_KEYS = new Set(['isolated', 'hostSuffix', 'branchedDatabases']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function componentGrantError(value: unknown): string | null {
	if (!isPlainObject(value)) return `'${COMPONENT_GRANT_KEY}' must be an object`;
	for (const key of Object.keys(value)) {
		if (key !== 'names' && key !== 'constraints') return `'${COMPONENT_GRANT_KEY}' has an unknown key '${key}'`;
	}
	const { names, constraints } = value;
	if (!Array.isArray(names) || names.length === 0) {
		return `'${COMPONENT_GRANT_KEY}.names' must be a non-empty array of component names or patterns`;
	}
	const invalid = names.find((name) => !isComponentNamePattern(name));
	if (invalid !== undefined) {
		return (
			`'${COMPONENT_GRANT_KEY}.names' entry ${JSON.stringify(invalid)} is not a component name, or a name prefix ` +
			`followed by one '*'`
		);
	}
	if (constraints === undefined) return null;
	if (!isPlainObject(constraints)) return `'${COMPONENT_GRANT_KEY}.constraints' must be an object`;
	for (const key of Object.keys(constraints)) {
		if (!CONSTRAINT_KEYS.has(key)) return `'${COMPONENT_GRANT_KEY}.constraints' has an unknown key '${key}'`;
	}
	if (constraints.isolated !== undefined && constraints.isolated !== true) {
		return `'${COMPONENT_GRANT_KEY}.constraints.isolated' can only be true`;
	}
	if (
		constraints.hostSuffix !== undefined &&
		(typeof constraints.hostSuffix !== 'string' || !HOST_SUFFIX.test(constraints.hostSuffix))
	) {
		return `'${COMPONENT_GRANT_KEY}.constraints.hostSuffix' must be a domain beginning with '.', such as '.app.example.com'`;
	}
	if (constraints.branchedDatabases !== undefined && constraints.branchedDatabases !== 'required') {
		return `'${COMPONENT_GRANT_KEY}.constraints.branchedDatabases' can only be 'required'`;
	}
	return null;
}

/**
 * The grant a request is made under: none for a super user, whose role reaches every component anyway, or for a role
 * without one. A malformed grant, which only an inline role could carry past validation, covers nothing.
 */
export function componentGrantOf(user: any): ComponentGrant | undefined {
	const permission = user?.role?.permission;
	if (!permission || permission.super_user === true) return undefined;
	const grant = permission[COMPONENT_GRANT_KEY];
	if (grant === undefined) return undefined;
	return componentGrantError(grant) === null ? (grant as ComponentGrant) : { names: [] };
}

export function grantCoversComponent(grant: ComponentGrant, component: unknown): boolean {
	return typeof component === 'string' && grant.names.some((pattern) => componentNameMatches(pattern, component));
}

/** Why the grant does not allow publishing `routing` for `component`, or undefined when it does. */
export function componentGrantConstraintRefusal(
	grant: ComponentGrant,
	component: string,
	routing: PublishedRouting
): string | undefined {
	const constraints = grant.constraints;
	if (!constraints) return undefined;
	if (constraints.isolated && routing.isolated !== true) {
		return `'${component}' must be deployed as an isolated application under this role's component grant`;
	}
	if (constraints.hostSuffix !== undefined) {
		const host = typeof routing.host === 'string' ? routing.host.toLowerCase() : undefined;
		const suffix = constraints.hostSuffix.toLowerCase();
		if (!host || host.length <= suffix.length || !host.endsWith(suffix)) {
			return `'${component}' must be deployed with a host under '${constraints.hostSuffix}' under this role's component grant`;
		}
	}
	if (
		constraints.branchedDatabases === 'required' &&
		routing.branchedDatabases !== true &&
		!(Array.isArray(routing.branchedDatabases) && routing.branchedDatabases.length > 0)
	) {
		return `'${component}' must be deployed with branchedDatabases under this role's component grant`;
	}
	return undefined;
}
