import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tryFileLock, fileLockRelease } from '@harperfast/rocksdb-js';
import {
	closeRestoredGeneration,
	databasesLoaded,
	getDatabases,
	openRestoredGeneration,
	resolveDatabasePath,
} from '../resources/databases.ts';
import { existsSync } from 'node:fs';
import { getThisNodeName } from './nodeName.ts';
import { getHdbBasePath, get as envGet } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, SYSTEM_SCHEMA_NAME, SYSTEM_TABLE_NAMES } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

const MEMBERSHIP_LOCK_FILE = '.replication-membership.lock';
const MEMBERSHIP_DRAIN_TIMEOUT_MS = 30_000;
const MEMBERSHIP_DRAIN_POLL_MS = 100;

/** The operations that can give this node a replication peer. Removing one is never fenced. */
const MEMBERSHIP_OPERATIONS = new Set(['add_node', 'set_node', 'update_node', 'add_node_back']);

function membershipLockPath(): string {
	return join(getHdbBasePath(), MEMBERSHIP_LOCK_FILE);
}

export function changesReplicationMembership(body: { operation?: string; [key: string]: any }): boolean {
	if (MEMBERSHIP_OPERATIONS.has(body.operation)) return true;
	if (body.operation !== 'set_configuration') return false;
	return body.replication_routes !== undefined || body.replication?.routes !== undefined;
}

/**
 * Holds the membership lock shared for the whole life of an operation that can add a peer, so a
 * restore's exclusive hold — taken before its peer check and kept until it publishes — waits for
 * every such operation already admitted and refuses every later one.
 */
export function fenceMembershipChange<T extends Function>(body: any, operationFunction: T): T {
	if (!changesReplicationMembership(body)) return operationFunction;
	return (async (...args: any[]) => {
		const token = tryFileLock(membershipLockPath(), true);
		if (!token) {
			throw new ClientError(
				`${body.operation} cannot change replication membership while a restore is in progress on this node; retry once it finishes`,
				409
			);
		}
		try {
			return await operationFunction(...args);
		} finally {
			fileLockRelease(token);
		}
	}) as unknown as T;
}

/** Takes the membership lock exclusively, waiting for admitted membership changes to finish. */
export async function acquireMembershipFence(timeoutMs = MEMBERSHIP_DRAIN_TIMEOUT_MS): Promise<() => void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const token = tryFileLock(membershipLockPath());
		if (token) return () => fileLockRelease(token);
		if (Date.now() >= deadline) {
			throw new ClientError(
				'A replication membership change (or another restore) is in progress on this node; retry the restore once it finishes',
				409
			);
		}
		await delay(MEMBERSHIP_DRAIN_POLL_MS);
	}
}

/**
 * The replication peers this node has, read from the data harper-pro builds its node list from: every
 * `hdb_nodes` row but this node's own, and every configured route. Read directly rather than asked of
 * replication, so it answers before any plugin has loaded.
 */
export function listReplicationPeers(): string[] {
	const peers: string[] = [];
	const thisNode = getThisNodeName();
	forEachNodeRow((key, value) => {
		if (value != null && key !== thisNode) peers.push(String(key));
	});
	const routes = envGet(CONFIG_PARAMS.REPLICATION_ROUTES);
	if (Array.isArray(routes)) {
		for (const route of routes) {
			const label = typeof route === 'string' ? route : (route?.hostname ?? route?.host ?? route?.url);
			if (label != null) peers.push(`route ${label}`);
			else peers.push('a configured route');
		}
	}
	return peers;
}

/**
 * Reads `hdb_nodes` from the loaded `system` when this thread has one. The offline CLI has none, and a
 * scan would open every database — the restore target included, whose RocksDB lock the restore child
 * must find free — so it opens `system` alone, privately, and closes it again.
 */
function forEachNodeRow(visit: (key: unknown, value: unknown) => void): void {
	if (databasesLoaded()) {
		const nodes = getDatabases()[SYSTEM_SCHEMA_NAME]?.[SYSTEM_TABLE_NAMES.NODE_TABLE_NAME] as any;
		for (const { key, value } of nodes?.primaryStore?.getRange({}) ?? []) visit(key, value);
		return;
	}
	const systemPath = resolveDatabasePath(SYSTEM_SCHEMA_NAME);
	if (!existsSync(join(systemPath, 'CURRENT'))) {
		// no system database at all means no node rows; one this cannot read must not pass for that
		if (existsSync(`${systemPath}.mdb`)) {
			throw new ClientError(
				`Cannot tell whether this node has replication peers: its system database at ${systemPath}.mdb is LMDB`,
				409
			);
		}
		return;
	}
	const generation = openRestoredGeneration(systemPath, SYSTEM_SCHEMA_NAME);
	try {
		const nodes = generation.tables[SYSTEM_TABLE_NAMES.NODE_TABLE_NAME] as any;
		for (const { key, value } of nodes?.primaryStore?.getRange({}) ?? []) visit(key, value);
	} finally {
		closeRestoredGeneration(systemPath, generation);
	}
}

export function assertNoReplicationPeers(databaseName: string): void {
	const peers = listReplicationPeers();
	if (peers.length === 0) return;
	throw new ClientError(
		`Cannot restore database '${databaseName}' on a node with replication peers (${peers.join(', ')}): replication would either undo the restore or spread it to the cluster. Restore on a standalone node, then add fresh peers.`,
		409
	);
}
