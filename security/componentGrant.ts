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
 *       preview: required
 *       maxPreviews: 5
 *       maxTtlDays: 7
 * ```
 *
 * Where each part is enforced, and why: security/DESIGN.md.
 */
import { componentNameMatches, isComponentNamePattern } from '../utility/componentNames.ts';
import { isPreviewProjectOf } from '../utility/previewIdentity.ts';
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
	/** Every deploy is a PR preview of an application `A` whose `A-pr-*` is one of the grant's names. */
	preview?: 'required';
	/** At most this many previews of each application, in place of `deployment.previews.maxPerApplication`. */
	maxPreviews?: number;
	/** A preview's `expiresAt` is clamped to this many days after its deploy. */
	maxTtlDays?: number;
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
const CONSTRAINT_KEYS = new Set([
	'isolated',
	'hostSuffix',
	'branchedDatabases',
	'preview',
	'maxPreviews',
	'maxTtlDays',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

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
	if (constraints.preview !== undefined && constraints.preview !== 'required') {
		return `'${COMPONENT_GRANT_KEY}.constraints.preview' can only be 'required'`;
	}
	if (
		constraints.maxPreviews !== undefined &&
		!(Number.isSafeInteger(constraints.maxPreviews) && (constraints.maxPreviews as number) >= 1)
	) {
		return `'${COMPONENT_GRANT_KEY}.constraints.maxPreviews' must be a whole number of at least 1`;
	}
	if (
		constraints.maxTtlDays !== undefined &&
		!(
			typeof constraints.maxTtlDays === 'number' &&
			Number.isFinite(constraints.maxTtlDays) &&
			constraints.maxTtlDays > 0
		)
	) {
		return `'${COMPONENT_GRANT_KEY}.constraints.maxTtlDays' must be a positive number of days`;
	}
	if (
		(constraints.maxPreviews !== undefined || constraints.maxTtlDays !== undefined) &&
		constraints.preview !== 'required'
	) {
		return `'${COMPONENT_GRANT_KEY}.constraints.maxPreviews' and 'maxTtlDays' bound previews, so they need 'preview: required'`;
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

interface PreviewClaim {
	app?: unknown;
	pr?: unknown;
	expiresAt?: unknown;
}

/**
 * Why a deploy of `component` with `preview` metadata is refused under the grant's `preview: required`, or undefined
 * when it is not. The metadata names the application whose cap it counts against, so it has to be one the grant
 * previews: `shop-pr-pr-3` is covered by `shop-pr-*`, but as a preview of `shop-pr` it would escape `shop`'s cap.
 */
export function componentGrantPreviewRefusal(
	grant: ComponentGrant,
	component: string,
	preview: PreviewClaim | undefined
): string | undefined {
	if (grant.constraints?.preview !== 'required') return undefined;
	if (!preview || typeof preview.app !== 'string') {
		return `'${component}' must be deployed as a PR preview, with preview metadata, under this role's component grant`;
	}
	if (!grant.names.includes(`${preview.app}-pr-*`) || !isPreviewProjectOf(preview.app, component, preview.pr)) {
		return `'${component}' must be deployed as '<app>-pr-<n>', a preview of an application this role's component grant previews`;
	}
	return undefined;
}

/** The latest `expiresAt`, in epoch milliseconds, the grant allows a preview deployed at `now`. */
export function previewExpiryBound(grant: ComponentGrant | undefined, now: number): number | undefined {
	const days = grant?.constraints?.maxTtlDays;
	return days === undefined ? undefined : now + days * DAY_MS;
}

export function previewCapOf(grant: ComponentGrant | undefined): number | undefined {
	return grant?.constraints?.maxPreviews;
}
