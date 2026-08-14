'use strict';

// exchange_oidc_token — the unauthenticated half of OIDC trusted publishing (#2171).
//
// A CI runner presents an identity token minted by its provider. If the token verifies against a
// stored trust policy, Harper mints a short-lived operation token for the user that policy names.
// This is the only unauthenticated operation that yields a credential, so it fails closed and tells
// the caller as little as possible: every rejection is the same message, and the reason goes to the
// log. A caller who learns *which* check failed can enumerate a policy one claim at a time.

import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { databases, table, type Table } from '../../resources/databases.ts';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { validateBySchema } from '../../validation/validationWrapper.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { getUsersWithRolesCache } from '../user.ts';
import { createOperationToken } from '../tokenAuthentication.ts';
import { verifyIdentityToken } from './index.ts';
import { matchTrustPolicyClaims } from './claims.ts';
import { normalizeIssuer } from './jwks.ts';
import { loadEnabledPolicies } from './trustPolicyOperations.ts';
import type { OidcTrustPolicy, TokenClaims } from './types.ts';

const logger = loggerWithTag('oidc-trust');

/**
 * Lifetime of the minted operation token. Long enough to cover a slow deploy without the client
 * re-authenticating mid-run, short enough that the credential is worthless by the time it could
 * surface in a log. Compare the 30-day refresh token this replaces.
 */
const EXCHANGED_TOKEN_LIFETIME_SECONDS = 3600;

/** Padding on the replay record so it outlives the token by more than the verifier's clock leeway. */
const REPLAY_RECORD_PADDING_MS = 120_000;

/** Bounds the token we are willing to even parse; real identity tokens are ~1-2 KB. */
const MAX_TOKEN_LENGTH = 8192;

const TOKEN_USE_TABLE = 'hdb_oidc_token_use';

/**
 * Records which identity tokens have been spent, keyed by issuer and `jti`. Rows expire with the
 * token itself (`expiresAt`), so the table stays proportional to in-flight tokens rather than to
 * deploy history. Replicated like other system tables, which extends the check across the cluster —
 * though replication is asynchronous, so two truly simultaneous replays against different nodes can
 * still both land. That race is not a privilege escalation: whoever holds the token could obtain one
 * operation token regardless. What this stops is the realistic case — a token that leaks after a
 * legitimate run and is reused while still inside its window.
 */
function getTokenUseTable(): any {
	// table() both creates and registers into `databases.system`, so the lookup finds it on every
	// call after the first. Untyped at the call sites, matching components/secretOperations.ts: the
	// typed `put` overload takes an explicit target, and these callers use the record form.
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

/** Every rejection looks identical to the caller; the reason is for the operator reading the log. */
function rejectExchange(detail: string): never {
	logger.warn?.(`Rejecting OIDC token exchange: ${detail}`);
	throw new ClientError('Identity token was rejected', 401);
}

function describeRun(claims: TokenClaims): string {
	const parts = [
		claims.repository,
		claims.workflow_ref ?? claims.workflow_path,
		claims.environment && `environment=${claims.environment}`,
		claims.run_id && `run=${claims.run_id}`,
		claims.actor && `actor=${claims.actor}`,
	];
	return parts.filter(Boolean).join(' ');
}

/**
 * Verifies each candidate policy's audience at most once. Policies for one instance normally share
 * an audience, so this is usually a single verification; grouping keeps it that way rather than
 * re-verifying the signature per policy.
 */
async function findMatchingPolicy(
	token: string,
	issuer: string,
	policies: OidcTrustPolicy[]
): Promise<{ policy: OidcTrustPolicy; claims: TokenClaims } | undefined> {
	const verifiedByAudience = new Map<string, TokenClaims | undefined>();

	for (const policy of policies) {
		if (!verifiedByAudience.has(policy.audience)) {
			try {
				verifiedByAudience.set(
					policy.audience,
					await verifyIdentityToken(token, { issuer, audience: policy.audience })
				);
			} catch (error) {
				// verifyIdentityToken already logged the reason.
				verifiedByAudience.set(policy.audience, undefined);
				void error;
			}
		}
		const claims = verifiedByAudience.get(policy.audience);
		if (!claims) continue;

		const mismatch = matchTrustPolicyClaims(claims, policy.claims);
		if (mismatch) {
			logger.debug?.(`Trust policy '${policy.id}' did not match: ${mismatch}`);
			continue;
		}
		return { policy, claims };
	}
	return undefined;
}

/**
 * Marks an identity token as spent, rejecting one already recorded.
 *
 * Recorded before the token is minted, not after: if minting fails the credential is burned, which
 * costs a CI re-run. The reverse ordering would let a failure leave a spendable token behind.
 *
 * The get-then-put is not atomic. Harper's optimistic concurrency may serialize it in practice, but
 * this deliberately does not depend on that — see getTokenUseTable for why the race is tolerable.
 */
async function recordTokenUse(issuer: string, claims: TokenClaims, policyId: string): Promise<void> {
	const useTable = getTokenUseTable();
	const id = `${issuer}|${claims.jti}`;
	if (await useTable.get(id)) rejectExchange(`token ${claims.jti} has already been exchanged`);

	await useTable.put({
		id,
		policy_id: policyId,
		used_at: Date.now(),
		expiresAt: (claims.exp as number) * 1000 + REPLAY_RECORD_PADDING_MS,
	});
}

/**
 * Exchanges a CI identity token for a short-lived Harper operation token.
 *
 * Unauthenticated by design — this operation *is* the authentication, the same way
 * create_authentication_tokens is.
 */
export async function exchangeOidcToken(req: any) {
	const validation = validateBySchema(
		req,
		Joi.object({ token: Joi.string().min(1).max(MAX_TOKEN_LENGTH).required() }).unknown(true)
	);
	if (validation) throw new ClientError(validation.message);

	// Read `iss` without verifying, only to select candidate policies. Nothing is trusted from this
	// decode: the issuer it names must match a stored policy, and the signature is then checked
	// against that policy's issuer.
	const unverified = jwt.decode(req.token, { complete: true });
	let issuer: string;
	try {
		issuer = normalizeIssuer((unverified?.payload as any)?.iss);
	} catch {
		rejectExchange('token has no usable iss claim');
	}

	const policies = (await loadEnabledPolicies()).filter((policy) => policy.issuer === issuer);
	if (policies.length === 0) rejectExchange(`no enabled trust policy for issuer ${issuer}`);

	const matched = await findMatchingPolicy(req.token, issuer, policies);
	if (!matched) rejectExchange(`no trust policy matched a token from ${issuer}`);
	const { policy, claims } = matched;

	// Resolve the user before spending the token, so a policy pointing at a deleted or deactivated
	// user fails without burning a token the runner cannot re-mint.
	const users = await getUsersWithRolesCache();
	const user = users?.get(policy.user);
	if (!user) rejectExchange(`trust policy '${policy.id}' names user '${policy.user}', which does not exist`);
	if (user.active === false) rejectExchange(`trust policy '${policy.id}' names inactive user '${policy.user}'`);

	await recordTokenUse(issuer, claims, policy.id);

	const operationToken = await createOperationToken(
		{ username: user.username, super_user: user.role?.permission?.super_user === true },
		EXCHANGED_TOKEN_LIFETIME_SECONDS
	);

	// The audit trail for a credential handed to an external system: which policy, which user, and
	// which run presented the token.
	// TODO(#2171): route this through AuthAuditLog once the operation handler has request context.
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
