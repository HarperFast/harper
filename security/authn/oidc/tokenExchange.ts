'use strict';

// exchange_oidc_token — the unauthenticated half of OIDC trusted publishing (#2171).
//
// A CI runner presents an identity token minted by its provider. If it verifies against a stored
// trust policy, Harper mints a short-lived operation token for the user that policy names. This is
// the only unauthenticated operation that yields a credential, so it fails closed throughout and
// refuses through rejectToken, which tells the caller nothing beyond "no".

import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { createHash } from 'node:crypto';
import { databases, table, type Table } from '../../../resources/databases.ts';
import { ClientError } from '../../../utility/errors/hdbError.ts';
import { validateBySchema } from '../../../validation/validationWrapper.ts';
import { loggerWithTag } from '../../../utility/logging/logger.ts';
import harperLogger from '../../../utility/logging/harper_logger.ts';
import * as env from '../../../utility/environment/environmentManager.ts';
import { AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES, CONFIG_PARAMS } from '../../../utility/hdbTerms.ts';
import { getUsersWithRolesCache } from '../../user.ts';
import { createOperationToken } from '../../tokenAuthentication.ts';
import { rejectToken, verifyIdentityToken } from './identityToken.ts';
import { matchTrustPolicyClaims } from './claims.ts';
import { normalizeIssuer } from './jwks.ts';
import { profileForIssuer, type IdentityProviderProfile } from './providers/index.ts';
import { loadEnabledPolicies } from './trustPolicyOperations.ts';
import type { OidcTrustPolicy, TokenClaims } from './types.ts';

const logger = loggerWithTag('oidc-trust');
const { AuthAuditLog } = harperLogger;
// Same stream and same switches as every other authentication event (security/auth.ts), so an
// operator who turns on auth auditing sees OIDC exchanges alongside Basic, Bearer, and mTLS.
const authEventLog = harperLogger.forComponent('authentication').withTag('auth-event');

/** Long enough to cover a slow deploy, short enough to be worthless by the time it reaches a log. */
const EXCHANGED_TOKEN_LIFETIME_SECONDS = 3600;

/** Keeps the replay record alive past the token's expiry by more than the verifier's clock leeway. */
const REPLAY_RECORD_PADDING_MS = 120_000;

/** Real identity tokens are ~1-2 KB; this bounds what we are willing to even parse. */
const MAX_TOKEN_LENGTH = 8192;

const TOKEN_USE_TABLE = 'hdb_oidc_token_use';

/**
 * Spent identity tokens, keyed by the fingerprint below and expiring with the token, so the table
 * stays proportional to in-flight tokens rather than to deploy history and never holds a credential.
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
			// `audit: true` explicitly, NOT the default (which follows logging.auditLog). Auditing is the
			// replication change feed (databases.ts: "auditing must be enabled for replication"), and
			// replay records MUST replicate so a token spent on one node cannot be re-spent on another
			// inside its window. Without this, an operator with logging.auditLog:false would silently lose
			// cross-node replay protection. Its sibling hdb_oidc_trust is audited for the same reason.
			// (Lazy table() rather than the systemSchema+directive bootstrap because the expiresAt TTL
			// below is not expressible through CreateTableObject; this matches hdb_certificate_cache.)
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'policy_id' },
				{ name: 'used_at' },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
			],
		})
	);
}

/**
 * Records the exchange in the authentication audit stream. Emitted for failures as well as successes:
 * a run repeatedly failing to authenticate is exactly what an audit trail is for.
 */
function auditExchange(req: any, username: string | undefined, status: string, detail: Record<string, unknown>) {
	const logSuccessful = env.get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL) ?? false;
	const logFailed = env.get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGFAILED) ?? false;
	if (status === AUTH_AUDIT_STATUS.SUCCESS ? !logSuccessful : !logFailed) return;

	// serverHandlers injects baseRequest for NO_AUTH_OPERATIONS, so the transport details are here;
	// they stay optional because an in-process caller (server.operation) has none.
	const baseRequest = req?.baseRequest;
	const log: any = new (AuthAuditLog as any)(
		username,
		status,
		AUTH_AUDIT_TYPES.AUTHENTICATION,
		// Same precedence as every other auth event (security/auth.ts): behind a load balancer —
		// which is every Fabric and cloud deployment — `ip` is the proxy, so an audit trail for the
		// one unauthenticated credential-minting operation would record the proxy, not the runner.
		baseRequest?.headers?.['x-forwarded-for'] ?? baseRequest?.ip,
		baseRequest?.method,
		baseRequest?.pathname
	);
	log.auth_strategy = 'oidc';
	Object.assign(log, detail);
	if (status === AUTH_AUDIT_STATUS.SUCCESS) authEventLog.info?.(log);
	else authEventLog.error?.(log);
}

/**
 * Auditing must never change the outcome it is recording. The success emit sits inside the
 * exchange's try, so a throw there would be caught and re-reported as a FAILURE for a request that
 * actually succeeded; on the failure path a throw would replace the original error with the audit's.
 * Swallowing here fixes both, and keeps the two call sites free of defensive wrapping.
 */
function auditExchangeSafely(req: any, username: string | undefined, status: string, detail: Record<string, unknown>) {
	try {
		auditExchange(req, username, status, detail);
	} catch (error) {
		logger.warn?.(`Failed to emit OIDC exchange audit record: ${(error as Error).message}`);
	}
}

/** Verifies each distinct audience at most once, so N policies sharing one cost one verification. */
async function findMatchingPolicy(
	token: string,
	issuer: string,
	policies: OidcTrustPolicy[],
	profile: IdentityProviderProfile
): Promise<{ policy: OidcTrustPolicy; claims: TokenClaims } | undefined> {
	const claimsByAudience = new Map<string, TokenClaims | undefined>();

	for (const policy of policies) {
		// Re-validate specificity at exchange time. add_oidc_trust enforces these, but a stored row can
		// arrive another way — replication from an older node that predates a check, or a restored/older
		// system-DB backup — and the exchange must not trust that every row was validated when written.
		// Skip (don't honor) any row that would be rejected for writing, so an under-specified policy
		// (e.g. a repository pinned but no workflow/ref gate) can't mint a token. Fail closed.
		try {
			profile.assertAudienceIsSpecific(policy.audience);
			profile.assertPolicyIsSpecific(policy.claims);
		} catch (error) {
			logger.warn?.(`Ignoring trust policy '${policy.id}': ${(error as Error).message}`);
			continue;
		}

		if (!claimsByAudience.has(policy.audience)) {
			// verifyIdentityToken logs its own reason via rejectToken, but everything jwks.ts throws
			// (unknown kid, unreachable host, non-2xx, oversized body, bad JSON, no usable keys) is
			// thrown directly and would otherwise vanish here — the request then falls through to
			// "no trust policy matched", which is actively misleading when a policy DID match and the
			// failure was operational. Log every swallowed reason so an issuer outage is
			// distinguishable from a misconfigured policy in the log.
			const verified = await verifyIdentityToken(token, { issuer, audience: policy.audience }).catch((error) => {
				logger.warn?.(
					`Verification failed for policy '${policy.id}' (audience '${policy.audience}'): ${(error as Error).message}`
				);
				return undefined;
			});
			claimsByAudience.set(policy.audience, verified);
		}
		const claims = claimsByAudience.get(policy.audience);
		if (!claims) continue;

		const mismatch = matchTrustPolicyClaims(claims, policy.claims) ?? profile.vetoClaims?.(claims, policy.claims);
		if (!mismatch) return { policy, claims };
		logger.debug?.(`Trust policy '${policy.id}' did not match: ${mismatch}`);
	}
	return undefined;
}

/**
 * Identifies a token for replay purposes: a hash of its SIGNED INPUT (`header.payload`), not of the
 * whole token string. Keyed this way rather than on `issuer|jti` because not every issuer emits
 * `jti` (Azure uses `uti`, others omit it), so this is strictly more general.
 *
 * Hashing the raw token instead would be bypassable, because the signature segment is covered by
 * nothing. Base64url decoding ignores the surplus low bits of the final character, so for an RS256
 * signature there are 16 distinct spellings of that segment that decode to identical bytes — every
 * one of them passes `jwt.verify`, and every one hashes differently. One leaked identity token would
 * buy 16 operation tokens. ES* issuers add a second, independent vector, since `s → n−s` is a
 * different valid signature over the same input.
 *
 * The signed input has neither problem: it is exactly what the issuer asserted and what the
 * signature covers, so every variant spelling and every malleable re-signing of one assertion
 * collapses to one fingerprint. Hashed rather than stored so the table never holds a credential.
 */
function tokenFingerprint(token: string): string {
	// Not `slice(0, 2).join('.')` on a split of the whole token: lastIndexOf keeps this O(1) in the
	// signature length and cannot silently succeed on a malformed token with too few segments —
	// verifyIdentityToken has already established this is a well-formed three-segment JWT.
	const signedInput = token.slice(0, token.lastIndexOf('.'));
	return createHash('sha256').update(signedInput).digest('base64url');
}

/**
 * Marks an identity token as spent, refusing one already recorded.
 *
 * Recorded before the token is minted: if minting then fails the credential is burned, costing a CI
 * re-run, where the reverse ordering would leave a spendable token behind. The get-then-put is not
 * atomic and deliberately does not depend on Harper's optimistic concurrency to make it so — see
 * getTokenUseTable for why the race is tolerable.
 */
async function recordTokenUse(fingerprint: string, claims: TokenClaims, policyId: string): Promise<void> {
	const useTable = getTokenUseTable();
	if (await useTable.get(fingerprint)) rejectToken(`token ${fingerprint.slice(0, 12)} has already been exchanged`);

	await useTable.put({
		id: fingerprint,
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

	// Populated as identification progresses so a failure audits with whatever was established.
	const audit: Record<string, unknown> = {};
	let username: string | undefined;
	try {
		// Nothing is trusted from this decode; it only selects candidate policies, and the signature
		// is then checked against the issuer those policies declare.
		const unverified = jwt.decode(req.token, { complete: true });
		let issuer: string;
		try {
			issuer = normalizeIssuer((unverified?.payload as any)?.iss);
		} catch {
			rejectToken('token has no usable iss claim');
		}
		audit.issuer = issuer;

		const profile = profileForIssuer(issuer);
		audit.provider = profile.name;

		const policies = await loadEnabledPolicies(issuer);
		if (policies.length === 0) rejectToken(`no enabled trust policy for issuer ${issuer}`);

		const matched = await findMatchingPolicy(req.token, issuer, policies, profile);
		if (!matched) rejectToken(`no trust policy matched a token from ${issuer}`);
		const { policy, claims } = matched;
		audit.oidc_policy = policy.id;
		audit.principal = profile.describePrincipal(claims);

		// Resolved before the token is spent, so a policy naming a deleted or deactivated user fails
		// without burning a token the runner cannot re-mint.
		const users = await getUsersWithRolesCache();
		const user = users?.get(policy.user);
		if (!user) rejectToken(`trust policy '${policy.id}' names user '${policy.user}', which does not exist`);
		if (user.active === false) rejectToken(`trust policy '${policy.id}' names inactive user '${policy.user}'`);
		username = user.username;

		const fingerprint = tokenFingerprint(req.token);
		audit.token_fingerprint = fingerprint.slice(0, 12);
		await recordTokenUse(fingerprint, claims, policy.id);

		const operationToken = await createOperationToken(
			{
				username: user.username,
				super_user: user.role?.permission?.super_user === true,
				operations: policy.operations,
			},
			EXCHANGED_TOKEN_LIFETIME_SECONDS
		);
		if (policy.operations?.length) audit.scoped_operations = policy.operations;

		logger.info?.(`OIDC exchange: policy '${policy.id}' authenticated '${user.username}' for ${audit.principal}`);
		auditExchangeSafely(req, username, AUTH_AUDIT_STATUS.SUCCESS, audit);

		return {
			operation_token: operationToken,
			expires_in: EXCHANGED_TOKEN_LIFETIME_SECONDS,
			username: user.username,
			policy: policy.id,
		};
	} catch (error) {
		auditExchangeSafely(req, username, AUTH_AUDIT_STATUS.FAILURE, audit);
		throw error;
	}
}
