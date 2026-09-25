/**
 * The one definition of system.hdb_oidc_token_use, the spent-identity-token table the OIDC exchange
 * checks for replay.
 *
 * Every node must hold it in this shape whether or not it ever performs an exchange: passive cluster
 * members receive every replicated replay row, and only an `expiresAt` declared on the node itself
 * evicts them. So it is declared on every boot, by the 5.3.0 directive, and by the exchange path — see
 * dataLayer/DESIGN.md, "System table bootstrap".
 */

import { table, type Table } from '../../../resources/databases.ts';
import { ServerError } from '../../../utility/errors/hdbError.ts';
import { SYSTEM_SCHEMA_NAME, SYSTEM_TABLE_NAMES } from '../../../utility/hdbTerms.ts';

export const TOKEN_USE_TABLE = SYSTEM_TABLE_NAMES.OIDC_TOKEN_USE_TABLE_NAME;

export function declareTokenUseTable(): Table {
	return table<Table>({
		table: TOKEN_USE_TABLE,
		database: SYSTEM_SCHEMA_NAME,
		// Explicit rather than the logging.auditLog default: auditing is the replication change feed, and a
		// token spent on one node must be refused on the others.
		audit: true,
		schemaDefined: true,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'policy_id' },
			{ name: 'used_at' },
			{ name: 'expiresAt', expiresAt: true, indexed: true },
		],
	});
}

/**
 * Declares the table and waits for any `expiresAt` backfill that started. A backfill that fails still
 * settles, so its outcome is read back from the catalog; until a later declaration completes it, this
 * node's replay rows do not expire.
 */
export async function ensureTokenUseTable(): Promise<void> {
	const TokenUseTable = declareTokenUseTable();
	await TokenUseTable.indexingOperation;
	const expiresAt = TokenUseTable.dbisDB.getSync(`${TOKEN_USE_TABLE}/expiresAt`);
	if (!expiresAt?.expiresAt || !expiresAt.indexed || expiresAt.indexingFailed || expiresAt.indexingPID) {
		throw new ServerError(
			`system.${TOKEN_USE_TABLE}.expiresAt is not yet a completed expiration index (indexingFailed: ${Boolean(
				expiresAt?.indexingFailed
			)}, build in progress: ${Boolean(expiresAt?.indexingPID)}); replay records on this node will not expire until a later start completes it`
		);
	}
}
