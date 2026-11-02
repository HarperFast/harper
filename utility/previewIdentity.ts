// Node builtins only, like componentNames.ts: the CLI derives these names and claims too.

import { posix } from 'node:path';
import { PROJECT_NAME_PATTERN } from './componentNames.ts';

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
export const PREVIEW_WORKFLOW = '.github/workflows/preview.yaml';
export const PREVIEW_ENVIRONMENT = 'preview';
/** The close-event cleanup job's environment, which carries no required reviewers so a closure never waits on one. */
export const PREVIEW_CLEANUP_ENVIRONMENT = 'preview-cleanup';
/** The repository variable the preview workflow reads its target from; production deploys read `HARPER_CLI_TARGET`. */
export const PREVIEW_TARGET_VARIABLE = 'HARPER_PREVIEW_TARGET';

// What `harper preview deploy|drop|list` issue: `registration_info` is the CLI's version probe before a deploy and
// `get_deployment` its wait on a rolling restart.
export const CI_PREVIEW_OPERATIONS = [
	'deploy_component',
	'drop_component',
	'get_components',
	'get_deployment',
	'registration_info',
];
export const CI_PREVIEW_CLEANUP_OPERATIONS = ['drop_component'];
/** What `enable_previews` caps a preview's life at unless told otherwise: the TTL `harper preview deploy` sends. */
export const DEFAULT_PREVIEW_MAX_TTL_DAYS = 7;

// add_oidc_trust's id grammar (security/authn/oidc/trustPolicyOperations.ts).
const POLICY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function usageError(message: string): Error {
	return Object.assign(new Error(message), { statusCode: 400 });
}

export interface PreviewNames {
	role: string;
	user: string;
	policy: string;
	cleanupPolicy: string;
	/** The grant's component pattern, and the prefix every preview of the application is named with. */
	components: string;
}

/** The names Studio's preview panel must also use. */
export function derivePreviewNames(app: string): PreviewNames {
	if (typeof app !== 'string' || !PROJECT_NAME_PATTERN.test(app)) {
		throw usageError(`'app' must be a component name (letters, numbers, "-" and "_"), got ${JSON.stringify(app)}`);
	}
	const names = {
		role: `${app}-ci-preview`,
		user: `${app}-ci-preview`,
		policy: `github-actions-${app}-preview`,
		cleanupPolicy: `github-actions-${app}-preview-cleanup`,
		components: `${app}-pr-*`,
	};
	if (!POLICY_ID_PATTERN.test(names.cleanupPolicy)) {
		throw usageError(
			`"${names.cleanupPolicy}" is not a valid trust policy id (1–128 letters, numbers, "_", "-" or ".").`
		);
	}
	return names;
}

/** Whether `project` is the name a preview of `app` deploys as: `<app>-pr-<n>`, `n` a PR number. */
export function isPreviewProjectOf(app: string, project: unknown, pr?: unknown): boolean {
	if (typeof project !== 'string' || !project.startsWith(`${app}-pr-`)) return false;
	const number = project.slice(app.length + 4);
	return /^[1-9]\d*$/.test(number) && (pr === undefined || String(pr) === number);
}

export function buildWorkflowRef(repository: string, workflow: string, branch: string): string {
	return `${repository}/${workflow}@refs/heads/${branch}`;
}

/** The repository-relative path GitHub names in workflow_ref, used for both the file check and the claim. */
export function canonicalWorkflowPath(workflow: string): string {
	const normalized = posix.normalize(String(workflow).replaceAll('\\', '/')).replace(/^\.\//, '');
	if (
		!normalized.startsWith('.github/workflows/') ||
		normalized.split('/').length !== 3 ||
		!/\.ya?ml$/.test(normalized)
	) {
		throw usageError(
			`workflow=${workflow} must name a .yml or .yaml file in .github/workflows/, where GitHub reads workflows.`
		);
	}
	return normalized;
}

/** `app.` under the target's own host name, which every Fabric cluster serves with a wildcard certificate. */
export function defaultPreviewDomain(resolvedTarget: string | undefined): string | undefined {
	if (!resolvedTarget) return undefined;
	try {
		const { hostname } = new URL(resolvedTarget);
		return hostname && !/^[\d.]+$|^\[|^localhost$/i.test(hostname) ? `app.${hostname.toLowerCase()}` : undefined;
	} catch {
		return undefined;
	}
}
