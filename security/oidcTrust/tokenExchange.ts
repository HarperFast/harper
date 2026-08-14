'use strict';

// exchange_oidc_token — the unauthenticated half of OIDC trusted publishing (#2171).
//
// A CI runner presents an identity token minted by its provider. If it verifies against a stored
// trust policy, Harper mints a short-lived operation token for the user that policy names. This is
// the only unauthenticated operation that yields a credential, so it fails closed throughout and
// refuses through rejectToken, which tells the caller nothing beyond "no".

import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { databases, table, type Table } from '../../resources/databases.ts';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { validateBySchema } from '../../validation/validationWrapper.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { getUsersWithRolesCache } from '../user.ts';
import { createOperationToken } from '../tokenAuthentication.ts';
import { rejectToken, verifyIdentityToken } from './identityToken.ts';
import { matchTrustPolicyClaims } from './claims.ts';
import { normalizeIssuer } from './jwks.ts';
import { loadEnabledPolicies } from './trustPolicyOperations.ts';
import type { OidcTrustPolicy, TokenClaims } from './types.ts';

const logger = loggerWithTag('oidc-trust');

/** Long enough to cover a slow deploy, short enough to be worthless by the time it reaches a log. */
const EXCHANGED_TOKEN_LIFETIME_SECONDS = 3600;

/** Keeps the replay record alive past the token's expiry by more than the verifier's clock leeway. */
const REPLAY_RECORD_PADDING_MS = 120_000;

/** Real identity tokens are ~1-2 KB; this bounds what we are willing to even parse. */
const MAX_TOKEN_LENGTH = 8192;

const TOKEN_USE_TABLE = 'hdb_oidc_token_use';

/**
 * Spent identity tokens, keyed by issuer and `jti`, expiring with the token so the table stays
 * proportional to in-flight tokens rather than to deploy history.
 *
 * Replicated like other system tables, which extends the check across the cluster — but replication
 * is asynchronous, so two simultaneous replays against different nodes can both land. That race is
 * not a privilege escalation: whoever holds the token could obtain one operation token regardless.
 * What it stops is the realistic case, a token that leaks after a legitimate run and is reused
 * inside its window.
 *
 * table() also registers into `databases.system`, so the lookup finds it after the first call.
 */
function getTokenUseTable(): any {
	return (
		(databases as any).system?.[TOKEN_USE_TABLE] ??
		table<Table>({
			table: TOKEN_USE_TABLE,
			database: 'system',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'policy_id' },
				{ name: 'used_at' },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
			],
		})
	);
}

function describeRun(claims: TokenClaims): string {
	return [
		claims.repository,
		claims.workflow_ref ?? claims.workflow_path,
		claims.environment && `environment=${claims.environment}`,
		claims.run_id && `run=${claims.run_id}`,
		claims.actor && `actor=${claims.actor}`,
	]
		.filter(Boolean)
		.join(' ');
}

/** Verifies each distinct audience at most once, so N policies sharing one cost one verification. */
async function findMatchingPolicy(
	token: string,
	issuer: string,
	policies: OidcTrustPolicy[]
): Promise<{ policy: OidcTrustPolicy; claims: TokenClaims } | undefined> {
	const claimsByAudience = new Map<string, TokenClaims | undefined>();

	for (const policy of policies) {
		if (!claimsByAudience.has(policy.audience)) {
			// verifyIdentityToken logs its own reason for refusing.
			const verified = await verifyIdentityToken(token, { issuer, audience: policy.audience }).catch(() => undefined);
			claimsByAudience.set(policy.audience, verified);
		}
		const claims = claimsByAudience.get(policy.audience);
		if (!claims) continue;

		const mismatch = matchTrustPolicyClaims(claims, policy.claims);
		if (!mismatch) return { policy, claims };
		logger.debug?.(`Trust policy '${policy.id}' did not match: ${mismatch}`);
	}
	return undefined;
}

/**
 * Marks an identity token as spent, refusing one already recorded.
 *
 * Recorded before the token is minted: if minting then fails the credential is burned, costing a CI
 * re-run, where the reverse ordering would leave a spendable token behind. The get-then-put is not
 * atomic and deliberately does not depend on Harper's optimistic concurrency to make it so — see
 * getTokenUseTable for why the race is tolerable.
 */
async function recordTokenUse(issuer: string, claims: TokenClaims, policyId: string): Promise<void> {
	const useTable = getTokenUseTable();
	const id = `${issuer}|${claims.jti}`;
	if (await useTable.get(id)) rejectToken(`token ${claims.jti} has already been exchanged`);

	await useTable.put({
		id,
		policy_id: policyId,
		used_at: Date.now(),
		expiresAt: (claims.exp as number) * 1000 + REPLAY_RECORD_PADDING_MS,
	});
}

/**
 * Exchanges a CI identity token for a short-lived Harper operation token. Unauthenticated by design —
 * this operation *is* the authentication, the way create_authentication_tokens is against a password.
 */
export async function exchangeOidcToken(req: any) {
	const validation = validateBySchema(
		req,
		Joi.object({ token: Joi.string().min(1).max(MAX_TOKEN_LENGTH).required() }).unknown(true)
	);
	if (validation) throw new ClientError(validation.message);

	// Nothing is trusted from this decode; it only selects candidate policies, and the signature is
	// then checked against the issuer those policies declare.
	const unverified = jwt.decode(req.token, { complete: true });
	let issuer: string;
	try {
		issuer = normalizeIssuer((unverified?.payload as any)?.iss);
	} catch {
		rejectToken('token has no usable iss claim');
	}

	const policies = (await loadEnabledPolicies()).filter((policy) => policy.issuer === issuer);
	if (policies.length === 0) rejectToken(`no enabled trust policy for issuer ${issuer}`);

	const matched = await findMatchingPolicy(req.token, issuer, policies);
	if (!matched) rejectToken(`no trust policy matched a token from ${issuer}`);
	const { policy, claims } = matched;

	// Resolved before the token is spent, so a policy naming a deleted or deactivated user fails
	// without burning a token the runner cannot re-mint.
	const users = await getUsersWithRolesCache();
	const user = users?.get(policy.user);
	if (!user) rejectToken(`trust policy '${policy.id}' names user '${policy.user}', which does not exist`);
	if (user.active === false) rejectToken(`trust policy '${policy.id}' names inactive user '${policy.user}'`);

	await recordTokenUse(issuer, claims, policy.id);

	const operationToken = await createOperationToken(
		{ username: user.username, super_user: user.role?.permission?.super_user === true },
		EXCHANGED_TOKEN_LIFETIME_SECONDS
	);

	// The audit trail for a credential handed to an external system.
	// TODO(#2171): route through AuthAuditLog once the operation handler has request context.
	logger.info?.(
		`OIDC exchange: policy '${policy.id}' authenticated '${user.username}' for ${describeRun(claims)} (jti ${claims.jti})`
	);

	return {
		operation_token: operationToken,
		expires_in: EXCHANGED_TOKEN_LIFETIME_SECONDS,
		username: user.username,
		policy: policy.id,
	};
}
