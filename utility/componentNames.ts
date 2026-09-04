'use strict';

// The names a component deploy has to agree on across the CLI (`bin/`) and the server
// (`components/`): the project (component) name a deploy resolves to, the canonical form of a git
// host, and the hdb_secret names a deploy credential seals into.
//
// They live here, in one dependency-free module, because both sides derive them independently.
// `harper deploy setup=true` seals a credential on the client and grants it to a project; the deploy
// that later consumes it re-derives the secret name and the project from its own request. A
// divergence is silent — the secret lands in a row the deploy never reads, or is granted to a project
// the deploy isn't running as — so a second copy of any of these is a bug waiting on a future edit to
// one side. Node builtins only, so the CLI can import it without pulling in the server's
// databases/config surface.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Project (component) names accepted by the project-scoped operations: alphanumeric, dash, underscore. */
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;

/**
 * A credential entry's `host`: a bare host, optionally with a port — `github.com`,
 * `git.example.com:8443`. `normalizeGitHost` reduces most inputs to this form; anything still
 * outside it (an embedded space, a second `@`) is rejected rather than guessed at.
 */
export const GIT_HOST_PATTERN = /^[^\s/@\\]+$/;

/** `https://github.com/` / `GitHub.com` / `github.com/` all identify the same host. */
export function normalizeGitHost(host: string): string {
	return host
		.trim()
		.replace(/^[a-z0-9+.-]+:\/\//i, '')
		.replace(/^\/\//, '')
		.replace(/\/.*$/, '')
		.replace(/^[^@]*@/, '')
		.toLowerCase();
}

/**
 * The canonical form of an explicitly named project: `@scope/app` and `app.tgz` both deploy as
 * `app`. Every project-scoped operation reduces its `project` this way, so the CLI has to resolve the
 * same name the server will when it grants a credential to one.
 */
export function canonicalProjectName(project: string): string {
	return path.parse(project).name;
}

/** The project name a deploy derives from its `package` spec when no `project` was given. */
export function projectNameFromPackage(pkg: string): string {
	if (pkg.startsWith('git+ssh://')) {
		return path.basename(pkg.split('#')[0].replace(/\.git$/, ''));
	}

	if (pkg.startsWith('http://') || pkg.startsWith('https://')) {
		return path.basename(new URL(pkg.replace(/\.git$/, '')).pathname);
	}

	if (pkg.startsWith('file://')) {
		try {
			const { name } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
			return path.basename(name);
		} catch {
			//
		}
	}

	return path.basename(pkg);
}

/** The project name a directory deploy (`harper deploy` with no `package`) defaults to. */
export function directoryProjectName(cwd: string = process.cwd()): string {
	return path.basename(cwd);
}

/**
 * Deterministic name for the auto-minted secret backing a literal registry token: keyed by the
 * deploying component and the registry, so re-supplying (or rotating) the token on a later deploy
 * overwrites the same row rather than accumulating one per deploy. Sanitized to the set_secret name
 * grammar (`\w.-`), since a registry can carry a scheme, port, or path.
 */
export function deriveRegistrySecretName(component: string, registry: string): string {
	const registryKey = registry
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/^\/\//, '')
		.replace(/\/+$/, '')
		.toLowerCase()
		.replace(/[^\w.-]+/g, '_');
	const componentKey = String(component).replace(/[^\w.-]+/g, '_');
	return `deploy.${componentKey}.${registryKey}`;
}

/**
 * Deterministic name for the secret backing a literal git-host token, following the registry
 * convention above but with a `git` kind segment: a registry entry accepts a bare host too, so
 * without a distinguishing segment a git and a registry credential for the same host would derive
 * the same name and silently overwrite each other's secret. Keyed by host rather than by
 * repository: the credential entry identifies itself by host, so the name has to be derivable from
 * the entry alone for a rotation to overwrite the same row. A per-repository credential is
 * expressible today by scoping the token itself (a fine-grained PAT) rather than by splitting the
 * secret name.
 */
export function deriveGitSecretName(component: string, host: string): string {
	const hostKey = normalizeGitHost(host).replace(/[^\w.-]+/g, '_');
	const componentKey = String(component).replace(/[^\w.-]+/g, '_');
	return `deploy.${componentKey}.git.${hostKey}`;
}

/**
 * Component names Harper's root config claims for itself. The root config namespace holds core
 * settings sections and application entries side by side, so an application deployed under one of
 * these names overwrites the section and fails the next boot's config validation. Only `sql` is
 * listed: it is the one section whose schema is closed to unknown keys, so it is the one a stray
 * application entry breaks.
 */
export const RESERVED_COMPONENT_NAMES = new Set(['sql']);

export function isReservedComponentName(project: string): boolean {
	return RESERVED_COMPONENT_NAMES.has(project);
}
