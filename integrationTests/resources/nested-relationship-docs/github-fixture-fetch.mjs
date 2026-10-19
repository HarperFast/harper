import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function githubHeaders(url, token) {
	if (new URL(url).origin !== 'https://api.github.com') return {};
	return {
		Accept: 'application/vnd.github+json',
		...(token ? { Authorization: 'Bearer ' + token } : {}),
	};
}

export async function readGitHubText(url, { token, signal, timeout = 15_000 } = {}) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		let response;
		try {
			response = await fetch(url, {
				headers: githubHeaders(url, token),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
			});
			if (response.status === 200) return await response.text();
		} catch {
			response = undefined;
			if (signal?.aborted || attempt === 3)
				throw new Error(
					'Cannot read fixture URL ' + url + ' after ' + attempt + ' attempt(s): network error or timeout'
				);
		}
		let wait = 250 * 2 ** (attempt - 1);
		if (response) {
			const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
			await response.body?.cancel();
			if (!retryable || attempt === 3)
				throw new Error(
					'Cannot read fixture URL ' + url + ': HTTP ' + response.status + ' after ' + attempt + ' attempt(s)'
				);
			const retryAfter = response.headers.get('retry-after');
			if (retryAfter !== null) {
				const seconds = Number(retryAfter);
				const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
				if (Number.isFinite(requested)) wait = Math.max(0, requested);
			}
			if (wait > 2000)
				throw new Error(
					'Cannot read fixture URL ' + url + ': HTTP ' + response.status + ' requires a longer Retry-After'
				);
		}
		try {
			await delay(wait, undefined, { signal });
		} catch {
			throw new Error('Fixture comparison deadline exceeded while reading ' + url);
		}
	}
}

export function peerRevision(pr) {
	assert(pr.merged_at || pr.state === 'open', 'Companion PR closed without merging; update the fixture pairing');
	const revision = pr.merged_at ? 'main' : pr.head?.sha;
	assert(revision === 'main' || /^[a-f0-9]{40}$/.test(revision), 'Invalid companion revision');
	return revision;
}

export async function verifyPeerFixtures({
	localRoot,
	peerRoot,
	repository,
	pull,
	peerPath,
	token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
}) {
	const signal = AbortSignal.timeout(30_000);
	let revision;
	if (!peerRoot) {
		assert(!process.env.CI || token, 'Fixture parity in CI requires GH_TOKEN or GITHUB_TOKEN');
		const metadata = await readGitHubText('https://api.github.com/repos/' + repository + '/pulls/' + pull, {
			token,
			signal,
		});
		const pr = JSON.parse(metadata);
		revision = peerRevision(pr);
	}
	for (const name of ['examples.json', 'schema.graphql', 'resources.js', 'github-fixture-fetch.mjs']) {
		const expected = await readFile(resolve(localRoot, name), 'utf8');
		const actual = peerRoot
			? await readFile(resolve(peerRoot, name), 'utf8')
			: await readGitHubText(
					'https://raw.githubusercontent.com/' + repository + '/' + revision + '/' + peerPath + '/' + name,
					{ signal }
				);
		assert.strictEqual(
			actual.replace(/\r\n/g, '\n'),
			expected.replace(/\r\n/g, '\n'),
			name + ' differs from the companion repository; update both fixtures together'
		);
	}
}
