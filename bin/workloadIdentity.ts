/**
 * Client half of OIDC trusted publishing (#2171): ask the runtime for a workload identity token
 * addressed to this instance, trade it for a short-lived operation token via `exchange_oidc_token`.
 *
 * Structured as a provider list because the runtimes differ only in how the token is obtained.
 * GitHub Actions is entry one; a Kubernetes entry is `available()` testing for a projected
 * service-account token path and `requestToken()` reading that file. A runtime none of them
 * recognizes falls through to the CLI's other credential sources.
 */

import { httpRequest } from '../utility/common_utils.ts';

interface WorkloadIdentityProvider {
	name: string;
	/** True when this process can obtain a token from this runtime. */
	available(): boolean;
	/**
	 * Obtains an identity token bound to `audience`. Binding it is what makes the token unusable
	 * anywhere else — see SHARED_DEFAULT_AUDIENCE in security/authn/oidc/providers/githubActions.ts
	 * for what an unbound one costs.
	 */
	requestToken(audience: string): Promise<string>;
}

/** GitHub sets both of these on a job that declares `permissions: id-token: write`. */
const GITHUB_TOKEN_REQUEST_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL';
const GITHUB_TOKEN_REQUEST_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN';

const IDENTITY_REQUEST_TIMEOUT_MS = 10_000;

const githubActions: WorkloadIdentityProvider = {
	name: 'GitHub Actions',

	/**
	 * Both variables are required: GitHub sets them together, so their absence means the workflow did
	 * not grant `id-token: write` — a configuration answer, not a failure to report here.
	 */
	available(): boolean {
		return Boolean(process.env[GITHUB_TOKEN_REQUEST_URL] && process.env[GITHUB_TOKEN_REQUEST_TOKEN]);
	},

	async requestToken(audience: string): Promise<string> {
		const requestUrl = new URL(process.env[GITHUB_TOKEN_REQUEST_URL] as string);
		requestUrl.searchParams.set('audience', audience);

		const response = await fetch(requestUrl, {
			headers: {
				authorization: `Bearer ${process.env[GITHUB_TOKEN_REQUEST_TOKEN]}`,
				accept: 'application/json',
			},
			signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`GitHub returned ${response.status} for an identity token`);

		const body: any = await response.json();
		if (typeof body?.value !== 'string' || body.value === '') {
			throw new Error('GitHub returned no identity token value');
		}
		return body.value;
	},
};

const PROVIDERS: WorkloadIdentityProvider[] = [githubActions];

function activeProvider(): WorkloadIdentityProvider | undefined {
	return PROVIDERS.find((provider) => provider.available());
}

/** True when this runtime can prove its own identity to the cluster. */
export function workloadIdentityAvailable(): boolean {
	return activeProvider() !== undefined;
}

/**
 * Trades a workload identity token for a Harper operation token, or undefined when this runtime has
 * no identity to offer. Failures are reported and swallowed: this is the last credential source
 * before the request goes out unauthenticated, and the resulting 401 says nothing useful, so the
 * reason is worth printing even though it is not by itself fatal.
 */
export async function exchangeWorkloadIdentityForToken(options: any, audience: string): Promise<string | undefined> {
	const provider = activeProvider();
	if (!provider) return undefined;

	console.error(`Requesting a ${provider.name} identity token for ${audience}...`);
	let identityToken: string;
	try {
		identityToken = await provider.requestToken(audience);
	} catch (error) {
		console.error(`Could not obtain a ${provider.name} identity token: ${(error as Error).message}`);
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
				'Harper rejected the identity token. Check that a trust policy matches this workload ' +
					'(list_oidc_trust) and that its audience is this instance; the server log records the reason.'
			);
			return undefined;
		}
		console.error(`OIDC exchange failed: ${response.statusCode}`);
		return undefined;
	} catch (error) {
		console.error(`Error exchanging the identity token: ${(error as Error).message}`);
		return undefined;
	}
}
