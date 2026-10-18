import { threadId } from 'node:worker_threads';
import { serialize } from 'node:v8';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import { getFullTextContinuationRoutingKey, processIncarnation } from '../../server/threads/manageThreads.js';
import { loadFullTextNativeBinding, getValidatedFullTextRuntimeInfo } from './fullTextNativeBinding.ts';
import type { NativeFullTextSearchPageResult } from './fullTextNativeBinding.ts';
import { FullTextContinuationToken, type FullTextContinuationPosition } from './fullTextContinuationToken.ts';
import { FullTextContinuationLeases } from './fullTextContinuationLease.ts';
import type { FullTextCursorClaim } from './fullTextContinuation.ts';

export type FullTextContinuationOwnerCommand =
	| { operation: 'resume'; token: string; queryHash: string }
	| { operation: 'read'; id: string; queryHash: string; position: FullTextContinuationPosition; responseBytes: number }
	| { operation: 'seal'; id: string; queryHash: string; position: FullTextContinuationPosition }
	| { operation: 'close'; token: string; queryHash: string };

export type FullTextContinuationOwnerResult =
	| { claim: FullTextCursorClaim; position: FullTextContinuationPosition }
	| NativeFullTextSearchPageResult
	| string
	| undefined;

type Owner = {
	tokens: FullTextContinuationToken;
	leases: FullTextContinuationLeases;
	responseBytes(batchSize: number): number;
};
let owner: Promise<Owner> | undefined;
let resolvedOwner: Owner | undefined;

export function peekFullTextContinuationOwner(): Owner | undefined {
	return resolvedOwner;
}

export function fullTextContinuationOwner() {
	owner ??= loadFullTextNativeBinding()
		.then((binding) => {
			const info = getValidatedFullTextRuntimeInfo(binding);
			const tokens = new FullTextContinuationToken(
				getFullTextContinuationRoutingKey(),
				processIncarnation,
				threadId,
				info.limits.maxSearchPageSize
			);
			return (resolvedOwner = {
				tokens,
				leases: new FullTextContinuationLeases(
					tokens,
					info.limits.maxSearchPageSize,
					info.limits.maxSearchBudgetMilliseconds
				),
				// IPC uses UTF-8 strings plus structured-clone metadata rather than native framing.
				responseBytes(batchSize: number) {
					if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > info.limits.maxSearchPageSize)
						throw new ClientError('Invalid full-text continuation page', 400);
					return Math.min(
						info.limits.maxSearchResponseBytes + batchSize * 128 + 32 * 1024,
						batchSize * (info.limits.maxRecordIdBytes + info.limits.maxRecordVersionBytes + 128) + 32 * 1024
					);
				},
			});
		})
		.catch((error) => {
			owner = undefined;
			throw error;
		});
	return owner;
}

export async function executeFullTextContinuationOwner(
	command: FullTextContinuationOwnerCommand,
	deadline: bigint
): Promise<FullTextContinuationOwnerResult> {
	const { leases, responseBytes } = await fullTextContinuationOwner();
	if (process.hrtime.bigint() >= deadline)
		throw new ServerError('Full-text continuation exceeded its request budget', 503);
	if (!command || !/^[a-f0-9]{64}$/.test(command.queryHash))
		throw new ClientError('Invalid full-text continuation request', 400);
	switch (command.operation) {
		case 'resume':
			return leases.resume(command.token, command.queryHash);
		case 'seal':
			return leases.seal(command.id, command.queryHash, command.position);
		case 'close':
			await leases.close(command.token, command.queryHash);
			return;
		case 'read': {
			if (
				!Number.isSafeInteger(command.responseBytes) ||
				command.responseBytes < responseBytes(command.position.batchSize)
			)
				throw new ServerError('Full-text continuation response capacity is unavailable', 503);
			const page = await leases.read(command.id, command.queryHash, command.position, deadline);
			if (serialize(page).byteLength + 1024 > command.responseBytes)
				throw new ServerError('Full-text continuation response exceeded its byte budget', 503);
			return page;
		}
		default:
			throw new ClientError('Invalid full-text continuation request', 400);
	}
}
