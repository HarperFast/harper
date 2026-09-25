/**
 * Every node must declare system.hdb_oidc_token_use in this shape whether or not it ever performs an
 * exchange: passive cluster members receive every replicated replay row, and only an `expiration` stored
 * in the node's own catalog arms the cleanup scan that removes them. See dataLayer/DESIGN.md, "System
 * table bootstrap".
 */

import { table, type Table } from '../../../resources/databases.ts';
import { SYSTEM_SCHEMA_NAME, SYSTEM_TABLE_NAMES } from '../../../utility/hdbTerms.ts';

export const TOKEN_USE_TABLE = SYSTEM_TABLE_NAMES.OIDC_TOKEN_USE_TABLE_NAME;

/**
 * A replay record's own expiry (its token's `exp` plus padding, written as record metadata and
 * replicated with it) outranks this, so it only bounds a row written without one. It is here because a
 * stored table-level expiration is what arms the cleanup scan when a node loads the table.
 */
const FALLBACK_EXPIRATION_SECONDS = 86_400;

export function declareTokenUseTable(): Table {
	return table<Table>({
		table: TOKEN_USE_TABLE,
		database: SYSTEM_SCHEMA_NAME,
		// Explicit rather than the logging.auditLog default: auditing is the replication change feed, and a
		// token spent on one node must be refused on the others.
		audit: true,
		schemaDefined: true,
		expiration: FALLBACK_EXPIRATION_SECONDS,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'policy_id' }, { name: 'used_at' }],
	});
}
