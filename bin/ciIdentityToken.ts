/**
 * CI-side half of OIDC trusted publishing (#2171): ask the provider for an identity token addressed
 * to this instance, trade it for a short-lived operation token via `exchange_oidc_token`.
 *
 * GitHub Actions only for now. Other providers expose the same idea through different plumbing, so
 * detection stays explicit rather than guessed — an unrecognized runner falls through to the CLI's
 * other credential sources.
 */

import { httpRequest } from '../utility/common_utils.ts';

/** GitHub sets both of these on a job that declares `permissions: id-token: write`. */
const GITHUB_TOKEN_REQUEST_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL';
const GITHUB_TOKEN_REQUEST_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN';

const IDENTITY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Both variables are required: GitHub sets them together, so their absence means the workflow did
 * not grant `id-token: write` — a configuration answer, not a failure to report here.
 */
export function ciIdentityAvailable(): boolean {
	return Boolean(process.env[GITHUB_TOKEN_REQUEST_URL] && process.env[GITHUB_TOKEN_REQUEST_TOKEN]);
}

/**
 * Passing `audience` explicitly is what makes the token unusable anywhere else — GitHub's default is
 * shared org-wide (see SHARED_DEFAULT_AUDIENCE in security/oidcTrust/trustPolicyOperations.ts).
 */
async function requestGithubIdentityToken(audience: string): Promise<string> {
	const requestUrl = new URL(process.env[GITHUB_TOKEN_REQUEST_URL] as string);
	requestUrl.searchParams.set('audience', audience);

	const response = await fetch(requestUrl, {
		headers: {
			authorization: `Bearer ${process.env[GITHUB_TOKEN_REQUEST_TOKEN]}`,
			accept: 'application/json',
		},
		signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`GitHub returned ${response.status} for an identity token`);
	}
	const body: any = await response.json();
	if (typeof body?.value !== 'string' || body.value === '') {
		throw new Error('GitHub returned no identity token value');
	}
	return body.value;
}

/**
 * Trades a CI identity token for a Harper operation token, or undefined when there is no identity to
 * offer. Failures are reported and swallowed: this is the last credential source before the request
 * goes out unauthenticated, and the resulting 401 says nothing useful, so the reason is worth
 * printing even though it is not by itself fatal.
 */
export async function exchangeCiIdentityForToken(options: any, audience: string): Promise<string | undefined> {
	if (!ciIdentityAvailable()) return undefined;

	console.error(`Requesting a CI identity token for ${audience}...`);
	let identityToken: string;
	try {
		identityToken = await requestGithubIdentityToken(audience);
	} catch (error) {
		console.error(`Could not obtain a CI identity token: ${(error as Error).message}`);
		return undefined;
	}

	try {
		const response = await httpRequest(options, { operation: 'exchange_oidc_token', token: identityToken });
		if (response.statusCode === 200) {
			const data = JSON.parse(response.body);
			if (data.operation_token) {
				console.error(`Authenticated as '${data.username}' via OIDC trust policy '${data.policy}'.`);
				return data.operation_token;
			}
			console.error('The OIDC exchange returned no operation token.');
			return undefined;
		}
		if (response.statusCode === 401) {
			// The server deliberately does not say which check failed, so point at the two things the
			// operator can actually inspect rather than inventing a cause.
			console.error(
				'Harper rejected the CI identity token. Check that a trust policy matches this workflow ' +
					'(list_oidc_trust) and that its audience is this instance; the server log records the reason.'
			);
			return undefined;
		}
		console.error(`OIDC exchange failed: ${response.statusCode}`);
		return undefined;
	} catch (error) {
		console.error(`Error exchanging the CI identity token: ${(error as Error).message}`);
		return undefined;
	}
}
