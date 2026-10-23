/**
 * `harper preview deploy|drop|list`: the PR-preview lifecycle as three commands any CI can run, over the
 * same target and credentials as `harper deploy`.
 *
 * A preview of `app` for PR `n` is the isolated component `<app>-pr-<n>`, served at `<slug>.<domain>`. The component
 * is named by PR number, not by slug, so socket paths stay short and renaming a branch moves the host, not the data
 * branch.
 */
import { createHash } from 'node:crypto';
import { buildRequest, cliOperations, resolveCredentialHost, transportContext } from './cliOperations.ts';
import { deriveGitSecretName, PROJECT_NAME_PATTERN } from '../utility/componentNames.ts';

const DEFAULT_SLUG_LENGTH = 40;
const DEFAULT_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set([
	'www',
	'dev',
	'stage',
	'staging',
	'prod',
	'production',
	'api',
	'app',
	'admin',
	'mail',
	'test',
]);
// Read here, never sent: everything else on the command line is a deploy_component field, as for `harper deploy`.
const PREVIEW_ARGUMENTS = ['app', 'pr', 'branch', 'label', 'domain', 'ttl', 'repository', 'sha'];
const GIT_CREDENTIAL_HOST = 'github.com';

function usageError(message: string): Error {
	return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * The branch as one lowercase DNS label: anything outside `[a-z0-9]` becomes `-`, runs collapse and the ends are
 * trimmed; past `max` characters it is cut, with a 6-character hash of the branch so two long branches stay apart;
 * a reserved or empty result falls back to `pr-<n>`.
 */
export function previewSlug(branch: string, pr: number, max: number = DEFAULT_SLUG_LENGTH): string {
	let slug = branch
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug || RESERVED_SLUGS.has(slug)) slug = `pr-${pr}`;
	if (slug.length > max) {
		const hash = createHash('sha256').update(branch).digest('hex').slice(0, 6);
		slug = `${slug.slice(0, max - 7).replace(/-+$/, '')}-${hash}`;
	}
	return slug;
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

/** As typed: `buildRequest` JSON-parses every value, which would read `branch=1.0` as `1`. */
function rawArgument(args: Record<string, any>, name: string): string | undefined {
	const raw = args._rawArgs?.[name] ?? args[name];
	return raw === undefined ? undefined : String(raw);
}

function previewProject(app: unknown, pr: unknown): { app: string; pr: number; project: string } {
	if (typeof app !== 'string' || !PROJECT_NAME_PATTERN.test(app)) {
		throw usageError('`app=<component>` names the application this is a preview of, e.g. app=shop');
	}
	if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) throw usageError('`pr=<n>` must be a PR number');
	return { app, pr, project: `${app}-pr-${pr}` };
}

interface ComponentEntry {
	name: string;
	host?: string;
	preview?: Record<string, unknown>;
}

/**
 * The deploy_component request a `harper preview deploy` sends. `components` is what the cluster serves now, so a slug
 * another open PR's preview holds gets `-pr<n>` appended rather than taking that preview's host.
 */
export function planPreviewDeploy(
	args: Record<string, any>,
	{
		components = [],
		resolvedTarget,
		now = Date.now(),
	}: { components?: ComponentEntry[]; resolvedTarget?: string; now?: number } = {}
): { request: Record<string, any>; host: string; project: string } {
	const { app, pr, project } = previewProject(args.app, args.pr);
	const branch = rawArgument(args, 'branch');
	if (!branch) throw usageError('`branch=<name>` is the PR head branch, which names the preview host');
	const label = rawArgument(args, 'label')?.toLowerCase();
	if (label !== undefined && (!DNS_LABEL.test(label) || label.length > 20)) {
		throw usageError('`label=` is one DNS label of at most 20 characters, such as the application name');
	}
	const domain = (rawArgument(args, 'domain') ?? defaultPreviewDomain(resolvedTarget))?.toLowerCase();
	if (!domain) throw usageError('`domain=<preview domain>` is required when the target is not a host name');

	let slug = label
		? `${previewSlug(branch, pr, DEFAULT_SLUG_LENGTH - label.length - 1)}-${label}`
		: previewSlug(branch, pr);
	const heldByAnother = (candidate: string) =>
		components.some(
			(component) => component.name !== project && component.host?.toLowerCase() === `${candidate}.${domain}`
		);
	if (heldByAnother(slug)) slug = `${slug}-pr${pr}`;
	if (heldByAnother(slug)) {
		throw usageError(`${slug}.${domain} is already the host of another preview; pass label= to tell them apart`);
	}
	const host = `${slug}.${domain}`;

	const ttlDays = args.ttl === undefined ? DEFAULT_TTL_DAYS : Number(args.ttl);
	if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw usageError('`ttl=<days>` must be a positive number of days');
	const repository = rawArgument(args, 'repository') ?? process.env.GITHUB_REPOSITORY;
	const ref = rawArgument(args, 'ref');
	const sha = rawArgument(args, 'sha') ?? (ref && /^[0-9a-f]{7,64}$/i.test(ref) ? ref : undefined);
	const preview: Record<string, unknown> = {
		app,
		pr,
		branch,
		expiresAt: new Date(now + ttlDays * DAY_MS).toISOString(),
	};
	if (repository) preview.repository = String(repository);
	if (sha) preview.sha = String(sha);

	const request: Record<string, any> = { ...args, operation: 'deploy_component', project, host, preview };
	for (const argument of PREVIEW_ARGUMENTS) delete request[argument];
	request.isolated ??= true;
	// An empty list forks nothing and, unlike an omitted field, replaces what a redeploy would otherwise keep.
	if (request.branchedDatabases === false) request.branchedDatabases = [];
	else request.branchedDatabases ??= true;
	request.restart ??= true;
	// One credential granted to `<app>-pr-*` serves every preview, where `harper deploy credential=true` would name a
	// secret for this one PR's component.
	const credentialHost = resolveCredentialHost(args.credential, GIT_CREDENTIAL_HOST);
	if (credentialHost && request.credentials === undefined) {
		request.credentials = [{ host: credentialHost, secret: deriveGitSecretName(`${app}-pr-*`, credentialHost) }];
		delete request.credential;
	}
	if (args._rawArgs) Object.defineProperty(request, '_rawArgs', { value: args._rawArgs, writable: true });
	return { request, host, project };
}

async function listComponents(
	args: Record<string, any>
): Promise<{ entries: ComponentEntry[]; resolvedTarget?: string }> {
	const response: any = await cliOperations({ ...transportContext(args), operation: 'get_components' }, true);
	return {
		entries: Array.isArray(response?.entries) ? response.entries : [],
		resolvedTarget: response?.resolvedTarget,
	};
}

export function formatPreviewList(entries: ComponentEntry[], app?: string): string {
	const previews = entries.filter((entry) => entry.preview && (app === undefined || entry.preview.app === app));
	if (previews.length === 0) return app ? `No previews of ${app}.` : 'No previews.';
	return previews
		.map(({ name, host, preview }) =>
			[
				name,
				`PR ${preview!.pr}`,
				preview!.branch,
				preview!.sha ? String(preview!.sha).slice(0, 12) : undefined,
				host ? `https://${host}/` : undefined,
				preview!.expiresAt ? `expires ${preview!.expiresAt}` : undefined,
			]
				.filter(Boolean)
				.join('  ')
		)
		.join('\n');
}

export async function runPreviewCommand(argv: readonly string[] = process.argv): Promise<string | undefined> {
	const action = argv[3];
	const args = buildRequest();
	delete args.operation;
	switch (action) {
		case 'deploy': {
			const { entries, resolvedTarget } = await listComponents(args);
			const { request, host } = planPreviewDeploy(args, { components: entries, resolvedTarget });
			await cliOperations(request);
			return `Preview: https://${host}/`;
		}
		case 'drop': {
			const { project } = previewProject(args.app, args.pr);
			const { entries } = await listComponents(args);
			if (!entries.some((entry) => entry.name === project)) return `${project} is not deployed; nothing to drop.`;
			await cliOperations({ ...transportContext(args), operation: 'drop_component', project }, true);
			return `Dropped ${project}.`;
		}
		case 'list':
			return formatPreviewList((await listComponents(args)).entries, args.app);
		default:
			throw usageError(
				'usage: harper preview deploy app=<component> pr=<n> branch=<name> [label=<dns-label>] [domain=<domain>] ' +
					'[ttl=<days>] | harper preview drop app=<component> pr=<n> | harper preview list [app=<component>]'
			);
	}
}
