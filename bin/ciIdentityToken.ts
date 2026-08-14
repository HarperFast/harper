/**
 * CI-side half of OIDC trusted publishing (#2171).
 *
 * On a runner that offers an OIDC identity token, the CLI can authenticate with no stored Harper
 * credential at all: it asks the CI provider for a token addressed to this instance, and trades it
 * for a short-lived operation token via `exchange_oidc_token`.
 *
 * GitHub Actions only for now. Other providers expose the same idea through different plumbing, so
 * detection stays explicit rather than guessed — a runner we do not recognize simply falls through
 * to the CLI's other credential sources.
 */

import { httpRequest } from '../utility/common_utils.ts';

/** GitHub sets both of these on a job that declares `permissions: id-token: write`. */
const GITHUB_TOKEN_REQUEST_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL';
const GITHUB_TOKEN_REQUEST_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN';

const IDENTITY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * True when this process is running somewhere that can mint an identity token. Both variables are
 * required: GitHub sets them together, and their absence on an Actions runner means the workflow
 * did not grant `id-token: write` — which is a configuration answer, not a failure to report here.
 */
export function ciIdentityAvailable(): boolean {
	return Boolean(process.env[GITHUB_TOKEN_REQUEST_URL] && process.env[GITHUB_TOKEN_REQUEST_TOKEN]);
}

/**
 * Asks GitHub for an identity token addressed to `audience`.
 *
 * The audience is what binds the token to this Harper instance. GitHub's default audience is the
 * repository owner's URL, shared by every repository under that owner, so passing the resolved
 * target explicitly is not a nicety — it is what makes the token unusable anywhere else.
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
 * Trades a CI identity token for a Harper operation token, or returns undefined when this runner
 * has no identity to offer.
 *
 * Failures are reported and swallowed rather than thrown. This runs as the last credential source
 * before the request would go out unauthenticated, and the resulting 401 says nothing useful — so
 * the reason the exchange did not work is worth printing even though it is not, by itself, fatal.
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
