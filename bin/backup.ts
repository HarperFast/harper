'use strict';

import { createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as YAML from 'yaml';
import * as envMgr from '../utility/environment/environmentManager.ts';
envMgr.initSync();
import * as terms from '../utility/hdbTerms.ts';
import { buildRequest, cliOperations, resolveRequestOptions } from './cliOperations.ts';
import { loadCredentials } from './cliCredentials.ts';
import { httpRequest } from '../utility/common_utils.ts';
import { initConfig } from '../config/configUtils.ts';
import { getHdbPid } from '../utility/processManagement/processManagement.js';
import {
	backupDirForDatabase,
	createBackupOffline,
	deleteBackupOffline,
	listBackupsInDir,
	purgeBackupsOffline,
	restoreBackupOffline,
	verifyBackupOffline,
} from '../dataLayer/rocksdbBackup.ts';

const { OPERATIONS_ENUM } = terms;

/**
 * Runs a backup operation from the CLI. `command` is the operation name (e.g. `create_backup`);
 * there is no hyphenated alias. Each works whether or not Harper is running: RocksDB is
 * single-writer, so when a server is reachable the running process must own the database handle
 * and the operation is forwarded to it (also handling remote `target=` and auth); only when the
 * *local* server is stopped do we open the database/backup files directly. `get_backup` is the
 * exception — it streams a live snapshot from a running server and has no offline form.
 */
export async function runBackupCommand(command: string): Promise<void> {
	// Load .env before anything reads process.env — useOperationApi and resolveRequestOptions key
	// the local-vs-remote routing off HARPER_CLI_TARGET/CLI_TARGET, and without this a `.env`-
	// configured remote target would be invisible, silently running a destructive op locally
	// (cliOperations does the same on its first line).
	require('dotenv').config();
	const request = buildRequest();
	const databaseName = request.database || 'data';

	// We print results here (not by returning a string) so the CLI's top-level handler doesn't
	// re-emit them through logger.notify — this keeps output identical to forwarding the operation
	// to a running server, which the online branch below simply delegates to.
	if (command === OPERATIONS_ENUM.GET_BACKUP) {
		console.log(await downloadBackup(request, databaseName));
		return;
	}

	// Fall back to direct file access only when there is no server to talk to (no target and the
	// local instance is stopped). We never fall back on a *reachable* server's error response —
	// e.g. restore_backup rejecting the system/component-held database (whose offline path is to
	// stop the server and rerun this same command, which then takes the branch below).
	if (useOperationApi(request)) {
		request.operation = command;
		await cliOperations(request); // prints its own result, exactly like any forwarded operation
		return;
	}

	let result: any;
	switch (command) {
		case OPERATIONS_ENUM.CREATE_BACKUP:
			result = await createBackupOffline(databaseName);
			break;
		case OPERATIONS_ENUM.LIST_BACKUPS:
			result = await listBackupsInDir(backupDirForDatabase(databaseName));
			break;
		case OPERATIONS_ENUM.VERIFY_BACKUP:
			result = await verifyBackupOffline(databaseName, request.backup_id, request.verify_checksum);
			break;
		case OPERATIONS_ENUM.DELETE_BACKUP:
			result = await deleteBackupOffline(databaseName, request.backup_id);
			break;
		case OPERATIONS_ENUM.PURGE_BACKUPS:
			result = await purgeBackupsOffline(databaseName, request.keep_count);
			break;
		case OPERATIONS_ENUM.RESTORE_BACKUP:
			result = await restoreBackupOffline(databaseName, request.backup_id, request.target_database);
			break;
		default:
			throw new Error(`Unknown backup command '${command}'`);
	}
	console.log(YAML.stringify(result).trim());
}

/**
 * Whether to route a backup command through the operation API rather than direct file access.
 * A configured target (explicit `target=`, env, or saved `last_target`) always implies a remote
 * server; otherwise we use the operation API only while the local instance is actually running
 * (`getHdbPid` verifies process liveness, so a stale pid file reads as stopped).
 */
function useOperationApi(request: any): boolean {
	if (request.target || process.env.HARPER_CLI_TARGET || process.env.CLI_TARGET || loadCredentials()?.last_target) {
		return true;
	}
	initConfig();
	return Boolean(getHdbPid());
}

/**
 * `get_backup` streams a full-snapshot tar of the database's current state from a running server
 * into a local file. It works against a remote server (`target=…`) or the local instance, resolving
 * the target and auth the same way as any other CLI operation; a local connection requires Harper to
 * be running (there is no offline form). For RocksDB the stream is gzipped by default; pass
 * `gzip=false` for a plain tar. While stopped, use `create_backup` — a local incremental directory
 * backup — instead.
 */
async function downloadBackup(request: any, databaseName: string): Promise<string> {
	// only forward gzip when the user passed it — it is a RocksDB-only option (sending it
	// unconditionally would fail LMDB downloads), and when unset the server applies its own
	// default (RocksDB gzips)
	const body: any = { operation: terms.OPERATIONS_ENUM.GET_BACKUP, database: databaseName };
	if (request.gzip !== undefined) body.gzip = request.gzip;
	// resolveRequestOptions connects to a remote target (target=/env/saved) or the local domain
	// socket with auth; for a local connection it enforces that Harper is running.
	const { options } = await resolveRequestOptions(request);
	options.streamResponse = true;
	const response = await httpRequest(options, body);
	if (response.statusCode !== 200) {
		const chunks: Buffer[] = [];
		for await (const chunk of response) chunks.push(Buffer.from(chunk));
		throw new Error(`get_backup failed (${response.statusCode}): ${Buffer.concat(chunks).toString('utf8')}`);
	}
	// name the file after what the server is sending (RocksDB: <db>.tar[.gz]; LMDB: the database file).
	// basename() strips any path from the server-supplied filename — a malicious/compromised target
	// could otherwise return `../../…` and steer the write outside the cwd.
	const serverFilename = response.headers['content-disposition']?.match(/filename="([^"]+)"/)?.[1];
	const outputPath = request.out || (serverFilename && basename(serverFilename)) || `${databaseName}.backup`;
	await pipeline(response, createWriteStream(outputPath));
	return `Backup of database '${databaseName}' written to ${outputPath}`;
}
