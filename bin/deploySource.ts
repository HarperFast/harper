import { execFileSync } from 'node:child_process';

/**
 * What a deploy that does not authenticate through OIDC says about where it came from. The server records it
 * as `source: { via: 'declared', … }`, and an exchanged token's attested source replaces it. Under GitHub Actions
 * that is the run; for a directory deploy it is also the checkout's commit, and whether the tree had changes the
 * commit does not hold. A package deploy names its own source, so the directory it was run from says nothing.
 */
export function declaredDeploySource(
	options: { directory?: string },
	env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> | undefined {
	const source: Record<string, unknown> = {};
	if (env.GITHUB_ACTIONS === 'true') {
		for (const [field, variable] of [
			['repository', 'GITHUB_REPOSITORY'],
			['sha', 'GITHUB_SHA'],
			['ref', 'GITHUB_REF'],
			['workflow_ref', 'GITHUB_WORKFLOW_REF'],
			['run_id', 'GITHUB_RUN_ID'],
			['run_attempt', 'GITHUB_RUN_ATTEMPT'],
			['actor', 'GITHUB_ACTOR'],
		]) {
			if (env[variable]) source[field] = env[variable];
		}
	}
	if (options.directory) {
		const head = git(options.directory, ['rev-parse', 'HEAD']);
		if (head) {
			source.sha = head;
			const status = git(options.directory, ['status', '--porcelain']);
			if (status !== undefined) source.dirty = status.length > 0;
		}
	}
	return Object.keys(source).length > 0 ? source : undefined;
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000,
		}).trim();
	} catch {
		return undefined;
	}
}
