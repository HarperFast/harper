'use strict';

// Operations against system.hdb_secret — the envelope-encrypted secrets store (#715).
//
// Only ciphertext is ever stored: a plaintext `value` submitted to set_secret is encrypted
// immediately with the cluster public key (custody must be registered) and the plaintext is
// discarded; processLocalTransaction strips `value`/`envelope` from the operations log before
// dispatch. Rows reach peers via normal system-table replication — these operations deliberately
// do NOT call replicateOperation (op replication on top of table replication would double-apply).
//
// All operations are super_user only, enforced in-handler in addition to the requiredPermissions
// registration: an `operations` allowlist on a role can otherwise delegate SU-only ops (see the
// gate-2 bypass in utility/operation_authorization.ts), and secret custody must not be delegable.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { databases } from '../resources/databases.ts';
import * as configUtils from '../config/configUtils.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError, handleHDBError, hdbErrors } from '../utility/errors/hdbError.ts';
import logger from '../utility/logging/harper_logger.ts';
import * as validator from './operationsValidation.js';
import { getSecretCustody } from '../resources/secretDecryptor.ts';
import { encryptEnvelope, parseEnvelopeFields } from '../utility/secretEnvelope.ts';
import { ENV_ENCRYPTED_PREFIX } from '../utility/envFile.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const SECRET_TABLE = terms.SYSTEM_TABLE_NAMES.SECRET_TABLE_NAME;

function requireSuperUser(req: any): void {
	if (!req?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError(
			`Operation '${req?.operation}' is restricted to super_user roles`,
			HTTP_STATUS_CODES.FORBIDDEN
		);
	}
}

function validate(validation: any): void {
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
}

function secretTable() {
	const table = (databases as any).system?.[SECRET_TABLE];
	if (!table) {
		throw new ClientError(
			`The secrets store is not initialized on this node (system.${SECRET_TABLE} missing). ` +
				`Run upgrade or restart the server to provision the table.`
		);
	}
	return table;
}

// Rebuild a plain record from a stored row's known attributes (never spread rows — RecordObject
// prototype fields don't survive a spread reliably; see DESIGN.md).
function toRecord(row: any) {
	return {
		name: row.name,
		envelope: row.envelope,
		kid: row.kid ?? null,
		grants: Array.isArray(row.grants) ? [...row.grants] : [],
		metadata: row.metadata ?? {},
		unverified: !!row.unverified,
		updated_by: row.updated_by ?? null,
	};
}

// True when a directory with the component's name exists under the components root. Advisory
// only (audit breadcrumb) — must never block or throw.
function componentIsKnown(component: string): boolean {
	try {
		return existsSync(join(configUtils.getConfigPath(terms.CONFIG_PARAMS.COMPONENTSROOT), component));
	} catch {
		return false;
	}
}

// Serialize read-modify-write mutations per secret name. The operations API dispatches these
// handlers on the MAIN thread only, so an in-process promise chain is sufficient to make the
// get→mutate→put of set_secret/grant_secret/revoke_secret/delete_secret atomic against local
// concurrency (without it, overlapping grant/revoke calls can silently drop each other's
// mutation). Cross-node concurrency remains last-write-wins on the whole row — the known
// system-table replication semantic.
const nameLocks = new Map<string, Promise<void>>();
async function withSecretLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const prior = nameLocks.get(name) ?? Promise.resolve();
	const run = prior.then(fn);
	// The stored tail never rejects, so a failed mutation doesn't poison the chain.
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	nameLocks.set(name, tail);
	try {
		return await run;
	} finally {
		if (nameLocks.get(name) === tail) nameLocks.delete(name);
	}
}

// Structured audit event for every mutation — operation, secret name, and user, never values.
function notifyMutation(operation: string, name: string, req: any, detail?: string) {
	logger.notify(
		`secret mutation: op=${operation} name=${name} user=${req?.hdb_user?.username ?? 'unknown'}${detail ? ` ${detail}` : ''}`
	);
}

/**
 * Upsert a secret. Exactly one of `value` (plaintext, encrypted immediately — requires custody)
 * or `envelope` (`enc:v1:...` ciphertext, encrypted client-side against get_secrets_public_key).
 * `kid` is derived from the envelope server-side; a client-supplied kid field is never trusted.
 * Never returns or logs plaintext.
 */
export async function setSecret(req: any) {
	requireSuperUser(req);
	validate(validator.setSecretValidator(req));

	const table = secretTable();
	const { name } = req;
	const custody = getSecretCustody();
	let envelope: string;
	let kid: string | null;
	let unverified = false;

	if (req.value !== undefined) {
		if (!custody) {
			throw new ClientError('secrets custody is not initialized on this node');
		}
		const { publicKey, fingerprint } = custody.getPublicKey();
		envelope = ENV_ENCRYPTED_PREFIX + encryptEnvelope(req.value, publicKey, fingerprint);
		kid = fingerprint;
		delete req.value; // plaintext is now sealed; drop the reference
	} else {
		// Deliberately NEVER decrypted server-side: a decrypt-verify would put the plaintext in
		// this thread's heap, defeating client-side encryption. Ingest checks are structural
		// (marker, base64url JSON, k/iv/ct/tag base64 fields) plus a kid-vs-custody fingerprint
		// match; a tampered-but-well-formed envelope is only caught at consumption time.
		envelope = req.envelope;
		if (!envelope.startsWith(ENV_ENCRYPTED_PREFIX)) {
			throw new ClientError(`'envelope' must start with '${ENV_ENCRYPTED_PREFIX}'`);
		}
		let fields;
		try {
			fields = parseEnvelopeFields(envelope.slice(ENV_ENCRYPTED_PREFIX.length));
		} catch (error) {
			throw new ClientError(`Invalid secret envelope: ${(error as Error).message}`);
		}
		kid = fields.kid ?? null;
		if (custody) {
			const { fingerprint } = custody.getPublicKey();
			if (kid !== null && kid !== fingerprint) {
				throw new ClientError(
					`Secret envelope kid '${kid}' does not match this cluster's secrets key ` +
						`(expected '${fingerprint}'; fetch it via get_secrets_public_key)`
				);
			}
			if (kid === null) {
				// No sealed kid to check against custody — accept, but surface it in list_secrets.
				unverified = true;
				logger.warn(`set_secret '${name}': envelope carries no kid; accepted without key-identity verification`);
			}
		} else {
			// No custody on this node: accept, but mark the row so a bad envelope is visible in
			// list_secrets instead of silently failing later.
			unverified = true;
			logger.warn(
				`set_secret '${name}': envelope accepted without verification (no secrets custody registered on this node)`
			);
		}
	}

	return withSecretLock(name, async () => {
		const existing = await table.get(name);
		await table.put({
			name,
			envelope,
			kid,
			grants: req.grants ?? (Array.isArray(existing?.grants) ? [...existing.grants] : []),
			metadata: req.metadata ?? existing?.metadata ?? {},
			unverified,
			updated_by: req.hdb_user?.username ?? null,
		});
		notifyMutation(terms.OPERATIONS_ENUM.SET_SECRET, name, req, unverified ? 'unverified=true' : undefined);
		return { name, kid, created: existing == null };
	});
}

async function mutateGrants(req: any, grant: boolean) {
	requireSuperUser(req);
	validate(validator.grantSecretValidator(req));

	const table = secretTable();
	return withSecretLock(req.name, async () => {
		const row = await table.get(req.name);
		if (!row) {
			throw new ClientError(`No secret found with name '${req.name}'`, HTTP_STATUS_CODES.NOT_FOUND);
		}
		const record = toRecord(row);
		const index = record.grants.indexOf(req.component);
		// No-op short-circuit: nothing to write, nothing to audit, no updated_by/__updatedtime__ bump.
		if (grant ? index >= 0 : index < 0) {
			return { name: req.name, grants: record.grants, changed: false };
		}
		if (grant) record.grants.push(req.component);
		else record.grants.splice(index, 1);
		record.updated_by = req.hdb_user?.username ?? null;
		await table.put(record);
		// Granting to a not-yet-deployed component is legal (grants may precede the deploy), but an
		// unknown name is worth a breadcrumb in the audit event — it is usually a typo.
		let detail = `component=${req.component}`;
		if (grant && !componentIsKnown(req.component)) detail += ' component_known=false';
		notifyMutation(
			grant ? terms.OPERATIONS_ENUM.GRANT_SECRET : terms.OPERATIONS_ENUM.REVOKE_SECRET,
			req.name,
			req,
			detail
		);
		return { name: req.name, grants: record.grants, changed: true };
	});
}

/** Add a component to a secret's grants list (idempotent). */
export function grantSecret(req: any) {
	return mutateGrants(req, true);
}

/** Remove a component from a secret's grants list (idempotent). */
export function revokeSecret(req: any) {
	return mutateGrants(req, false);
}

/**
 * List secret metadata: never envelopes, never values. Includes the node's current custody
 * fingerprint (null when custody is absent) and a per-row kid_matches_custody flag so stale rows
 * on a cloned/rekeyed node are immediately visible.
 */
export async function listSecrets(req: any) {
	requireSuperUser(req);

	const table = secretTable();
	const custody = getSecretCustody();
	const custodyFingerprint = custody ? custody.getPublicKey().fingerprint : null;
	const secrets: any[] = [];
	for await (const row of table.search([])) {
		secrets.push({
			name: row.name,
			kid: row.kid ?? null,
			grants: Array.isArray(row.grants) ? [...row.grants] : [],
			metadata: row.metadata ?? {},
			unverified: !!row.unverified,
			updated_by: row.updated_by ?? null,
			__createdtime__: row.__createdtime__,
			__updatedtime__: row.__updatedtime__,
			kid_matches_custody: custodyFingerprint !== null && row.kid === custodyFingerprint,
		});
	}
	secrets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	return { secrets, custody_fingerprint: custodyFingerprint };
}

/** Delete a secret row. Not cryptographic erasure — audit/txn logs and backups retain envelopes. */
export async function deleteSecret(req: any) {
	requireSuperUser(req);
	validate(validator.deleteSecretValidator(req));

	const table = secretTable();
	return withSecretLock(req.name, async () => {
		const row = await table.get(req.name);
		if (!row) {
			throw new ClientError(`No secret found with name '${req.name}'`, HTTP_STATUS_CODES.NOT_FOUND);
		}
		await table.delete(req.name);
		notifyMutation(terms.OPERATIONS_ENUM.DELETE_SECRET, req.name, req);
		return { message: `Successfully deleted secret '${req.name}'` };
	});
}

/** The cluster secrets public key, for client-side envelope encryption. */
export function getSecretsPublicKey(req: any) {
	requireSuperUser(req);
	const custody = getSecretCustody();
	if (!custody) {
		throw new ClientError('secrets custody is not initialized on this node');
	}
	const { publicKey, fingerprint } = custody.getPublicKey();
	return { public_key: publicKey, fingerprint };
}
