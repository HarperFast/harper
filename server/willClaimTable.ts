/**
 * `system.hdb_session_will_claim`: one row per MQTT connection with a client id, keyed `[clientId, incarnation]`,
 * that the startup will replay reads to tell whether a client connected again after a crash, here or on a peer
 * (server/DESIGN.md, "The boot replay"). Every node declares it in this shape at every writable start, whether or
 * not it serves MQTT: it replicates, and only an `expiration` stored in the node's own catalog arms the cleanup
 * scan that removes ended connections' rows replicated to it (dataLayer/DESIGN.md, "System table bootstrap").
 */

import { table, type Table } from '../resources/databases.ts';
import { SYSTEM_SCHEMA_NAME } from '../utility/hdbTerms.ts';

export const WILL_CLAIM_TABLE = 'hdb_session_will_claim';

/** How long an ended connection's row outlives it; a live connection's row is written with no expiry. */
export const ENDED_CLAIM_LIFETIME_MS = 7 * 86_400_000;

export function declareWillClaimTable(): Table {
	return table<Table>({
		table: WILL_CLAIM_TABLE,
		database: SYSTEM_SCHEMA_NAME,
		// replication rides the audit log, whatever logging.auditLog says
		audit: true,
		schemaDefined: true,
		expiration: ENDED_CLAIM_LIFETIME_MS / 1000,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'clientId', type: 'string', indexed: true },
			{ name: 'connectedAt', type: 'number' },
			{ name: 'ended', type: 'boolean' },
		],
	});
}
