'use strict';

// Operations against system.hdb_oidc_trust — the trust policies for OIDC trusted publishing (#2171).
//
// A policy lets an external CI run authenticate as a Harper user without holding any Harper
// credential, so these are super_user only. Following components/secretOperations.ts, super_user is
// enforced in-handler as well as via requiredPermissions: a role's `operations` allowlist can
// otherwise delegate an SU-only operation (see the gate-2 bypass in utility/operation_authorization.ts).
//
// Rows reach peers through normal system-table replication; these operations deliberately do not
// call replicateOperation, which would double-apply on top of it.

import Joi from 'joi';
import { databases } from '../../../resources/databases.ts';
import * as terms from '../../../utility/hdbTerms.ts';
import { ClientError, hdbErrors } from '../../../utility/errors/hdbError.ts';
import { validateBySchema } from '../../../validation/validationWrapper.ts';
import { getUsersWithRolesCache } from '../../user.ts';
import { validateClaimConstraintShape } from './claims.ts';
import { normalizeIssuer } from './jwks.ts';
import { profileForIssuer } from './providers/index.ts';
import { validateOperations } from '../../../utility/operationPermissions.ts';
import type { OidcTrustPolicy } from './types.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const OIDC_TRUST_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TRUST_TABLE_NAME;

const POLICY_ID = Joi.string()
	.min(1)
	.max(128)
	.pattern(/^[\w.-]+$/)
	.required()
	.messages({ 'string.pattern.base': "'id' may contain only letters, numbers, '_', '-', and '.'" });

function requireSuperUser(req: any): void {
	if (!req?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError(
			`Operation '${req?.operation}' is restricted to super_user roles`,
			HTTP_STATUS_CODES.FORBIDDEN
		);
	}
}

function validate(validation: any): void {
	if (validation) throw new ClientError(validation.message);
}

/**
 * A typo would otherwise fail closed at request time, in CI, with nothing to point at — so it is
 * caught here, where the reader is the administrator who wrote it. Delegates to the same helper
 * add_role/alter_role use, which accepts group names and operations registered at runtime via
 * server.registerOperation; a local OPERATIONS_ENUM check would reject those.
 */
function assertOperationsAreKnown(operations: string[]): void {
	const invalidOperation = validateOperations(operations);
	if (invalidOperation != null) {
		throw new ClientError(`operations contains '${invalidOperation}', which is not a Harper operation`);
	}
}

function trustTable() {
	const table = (databases as any).system?.[OIDC_TRUST_TABLE];
	if (!table) {
		throw new ClientError(
			`OIDC trust policies are not initialized on this node (system.${OIDC_TRUST_TABLE} missing). ` +
				`Run upgrade or restart the server to provision the table.`
		);
	}
	return table;
}

/**
 * Rebuild a plain record from a stored row's known attributes. Never spread rows — RecordObject
 * prototype fields don't survive a spread reliably (see DESIGN.md).
 */
function toRecord(row: any): OidcTrustPolicy & Record<string, unknown> {
	return {
		id: row.id,
		issuer: row.issuer,
		audience: row.audience,
		claims: row.claims ?? {},
		user: row.user,
		operations: row.operations ?? null,
		enabled: row.enabled !== false,
		description: row.description ?? null,
		updated_by: row.updated_by ?? null,
		__createdtime__: row.__createdtime__,
		__updatedtime__: row.__updatedtime__,
	} as any;
}

/**
 * The policy set is small and administrator-managed, so a scan beats maintaining an index — and
 * sorting by id keeps both the listing and the exchange's match order deterministic rather than
 * dependent on an index's iteration order.
 */
async function readPolicies(includeDisabled: boolean): Promise<OidcTrustPolicy[]> {
	const table = trustTable();
	const policies: OidcTrustPolicy[] = [];
	for await (const row of table.search([])) {
		if (!includeDisabled && row.enabled === false) continue;
		policies.push(toRecord(row));
	}
	return policies.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** The policies the exchange will consider. */
export function loadEnabledPolicies(): Promise<OidcTrustPolicy[]> {
	return readPolicies(false);
}

/**
 * Creates or replaces a trust policy.
 *
 * Replace rather than merge: a partial update to a claim set is how an over-broad policy gets
 * created by accident, and the whole point of `claims` is that every constraint in it was written
 * deliberately.
 */
export async function addOidcTrust(req: any) {
	requireSuperUser(req);
	validate(
		validateBySchema(
			req,
			Joi.object({
				id: POLICY_ID,
				issuer: Joi.string().min(1).max(512).required(),
				audience: Joi.string().min(1).max(512).required(),
				claims: Joi.object().min(1).required(),
				user: Joi.string().min(1).max(512).required(),
				operations: Joi.array().items(Joi.string().min(1)).min(1).max(100).unique(),
				enabled: Joi.boolean(),
				description: Joi.string().allow('').max(1024),
			}).unknown(true)
		)
	);

	const issuer = normalizeIssuer(req.issuer);
	// Issuer-specific rules live in the provider profile; an unregistered issuer gets the strict
	// generic profile rather than a permissive default. Each throws ClientError naming the problem.
	const profile = profileForIssuer(issuer);
	profile.assertAudienceIsSpecific(req.audience);
	if (req.operations) assertOperationsAreKnown(req.operations);
	validateClaimConstraintShape(req.claims);
	profile.assertPolicyIsSpecific(req.claims);

	// Resolve the target user now: a policy pointing at a user that does not exist would fail only at
	// exchange time, in CI, with nothing to point at. Read the users cache directly rather than
	// findAndValidateUser — with validatePassword false, that returns a bare `{ username }` for an
	// unknown user instead of failing, so it cannot answer "does this user exist".
	const users = await getUsersWithRolesCache();
	const targetUser = users?.get(req.user);
	if (!targetUser) {
		throw new ClientError(`No such user '${req.user}'; create the user before granting it to a workflow`);
	}
	if (targetUser.active === false) {
		throw new ClientError(`User '${req.user}' is inactive; a policy naming it could never authenticate`);
	}

	const table = trustTable();
	await table.put({
		id: req.id,
		issuer,
		audience: req.audience,
		claims: req.claims,
		user: req.user,
		operations: req.operations ?? null,
		enabled: req.enabled !== false,
		description: req.description ?? null,
		updated_by: req.hdb_user?.username ?? null,
	});

	const result: Record<string, unknown> = { message: `Successfully set OIDC trust policy '${req.id}'` };
	// Not an error — an admin may genuinely want this — but a policy that hands super_user to a
	// workflow deserves to be said out loud rather than discovered later.
	if (targetUser.role?.permission?.super_user) {
		result.warning =
			`Policy '${req.id}' authenticates as '${req.user}', which is a super_user. Any run matching this ` +
			`policy gains full administrative access; consider a user whose role grants only the operations CI needs.`;
	}
	return result;
}

export async function listOidcTrust(req: any) {
	requireSuperUser(req);
	return { policies: await readPolicies(true) };
}

export async function dropOidcTrust(req: any) {
	requireSuperUser(req);
	validate(validateBySchema(req, Joi.object({ id: POLICY_ID }).unknown(true)));

	const table = trustTable();
	const row = await table.get(req.id);
	if (!row) {
		throw new ClientError(`No OIDC trust policy found with id '${req.id}'`, HTTP_STATUS_CODES.NOT_FOUND);
	}
	await table.delete(req.id);
	return { message: `Successfully dropped OIDC trust policy '${req.id}'` };
}
