/**
 * Shared helpers for the harper#1817 redeploy-restart-flag regression tests
 * (`redeploy-restart-flag.test.ts` — modified-file case, `redeploy-restart-flag-deletion.test.ts` —
 * deleted-file case). Both exercise the same `deploy_component` → `get_status.restartRequired`
 * contract against a live Harper instance, so they share the same request plumbing.
 */
import { strictEqual } from 'node:assert';
import type { ContextWithHarper } from '@harperfast/integration-testing';

export function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

export async function operation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	strictEqual(response.status, 200, `operation ${body.operation} failed with ${response.status}`);
	return response.json();
}

export async function getRestartRequired(ctx: ContextWithHarper): Promise<boolean> {
	const status = await operation(ctx, { operation: 'get_status' });
	return status ? status.restartRequired === true : false;
}

export async function readVersion(ctx: ContextWithHarper): Promise<number | undefined> {
	let response: Response;
	try {
		response = await fetch(`${ctx.harper.httpURL}/Version`, { headers: { Authorization: authHeader(ctx) } });
	} catch {
		// restart:true returns before the new process is listening, so the poller can hit a bare
		// connection failure (ECONNREFUSED) rather than an HTTP response; treat it like a non-200.
		return undefined;
	}
	if (response.status !== 200) {
		await response.body?.cancel();
		return undefined;
	}
	const body = (await response.json()) as { version?: number } | null;
	return body ? body.version : undefined;
}
