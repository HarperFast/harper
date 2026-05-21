'use strict';

// Read-side operations against system.hdb_deployment. Slice A of issue #641.
// Write-side lives in deploymentRecorder.ts; this module only reads.

import { databases } from '../resources/databases.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

const DEPLOYMENT_TABLE = terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

interface ListRequest {
	project?: string;
	status?: string;
	since?: number;
	until?: number;
	limit?: number;
	offset?: number;
}

interface GetRequest {
	deployment_id: string;
}

function deploymentTable() {
	const table = (databases as any).system?.[DEPLOYMENT_TABLE];
	if (!table) {
		throw new ClientError(
			`Deployment tracking is not initialized on this node (system.${DEPLOYMENT_TABLE} missing). ` +
				`Run upgrade or restart the server to provision the table.`
		);
	}
	return table;
}

// Strip the blob attribute from a row; the bytes never travel over the operations API.
// Callers wanting bytes use get_deployment_payload (added in Slice B).
function stripBlob(row: any): any {
	if (!row || typeof row !== 'object') return row;
	const { payload_blob, ...rest } = row;
	rest.payload_blob_present = payload_blob != null;
	return rest;
}

export async function handleListDeployments(req: ListRequest = {}): Promise<{ deployments: any[]; total: number }> {
	const table = deploymentTable();
	const conditions: any[] = [];
	if (req.project) conditions.push({ attribute: 'project', value: req.project });
	if (req.status) conditions.push({ attribute: 'status', value: req.status });
	if (req.since != null) conditions.push({ attribute: 'started_at', value: req.since, comparator: 'greater_than_equal' });
	if (req.until != null) conditions.push({ attribute: 'started_at', value: req.until, comparator: 'less_than_equal' });

	const collected: any[] = [];
	for await (const row of table.search(conditions)) {
		collected.push(stripBlob(row));
	}
	// Newest first by started_at; ties broken by deployment_id for stability.
	collected.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || String(a.deployment_id).localeCompare(b.deployment_id));

	const total = collected.length;
	const offset = Math.max(0, req.offset ?? 0);
	const limit = req.limit != null ? Math.max(0, req.limit) : collected.length;
	return { deployments: collected.slice(offset, offset + limit), total };
}

export async function handleGetDeployment(req: GetRequest): Promise<any> {
	if (!req || !req.deployment_id) {
		throw new ClientError(`'deployment_id' is required`);
	}
	const table = deploymentTable();
	const row = await table.get(req.deployment_id);
	if (!row) {
		throw new ClientError(`No deployment found with id '${req.deployment_id}'`);
	}
	return stripBlob(row);
}
