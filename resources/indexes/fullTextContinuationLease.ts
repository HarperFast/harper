import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import type { FullTextCursorClaim } from './fullTextContinuation.ts';
import { FullTextContinuationToken, type FullTextContinuationPosition } from './fullTextContinuationToken.ts';
import type {
	NativeFullTextReader,
	NativeFullTextSearchExpression,
	NativeFullTextSearchPageResult,
} from './fullTextNativeBinding.ts';

type Lease = {
	claim: FullTextCursorClaim;
	queryHash: string;
	query: NativeFullTextSearchExpression;
	reader: NativeFullTextReader;
	release(): void;
	active: number;
	revoked: boolean;
	released: boolean;
	timer: NodeJS.Timeout;
	drained: Promise<void>;
	resolveDrained(): void;
};

export class FullTextContinuationLeases {
	readonly #tokens: FullTextContinuationToken;
	readonly #maxNativePageSize: number;
	readonly #maxNativeBudgetMilliseconds: number;
	readonly #leases = new Map<string, Lease>();

	constructor(tokens: FullTextContinuationToken, maxNativePageSize: number, maxNativeBudgetMilliseconds: number) {
		this.#tokens = tokens;
		this.#maxNativePageSize = maxNativePageSize;
		this.#maxNativeBudgetMilliseconds = maxNativeBudgetMilliseconds;
	}

	register(
		claim: FullTextCursorClaim,
		queryHash: string,
		query: NativeFullTextSearchExpression,
		reader: NativeFullTextReader,
		release: () => void
	): void {
		const duration = Number((claim.expires - process.hrtime.bigint()) / 1_000_000n);
		if (
			this.#leases.has(claim.id) ||
			duration < 1 ||
			duration > 0x7fffffff ||
			!/^[a-f0-9]{32}$/.test(claim.id) ||
			!/^[a-f0-9]{64}$/.test(queryHash)
		)
			throw expired();
		const { promise: drained, resolve: resolveDrained } = Promise.withResolvers<void>();
		const timer = setTimeout(
			() => {
				void this.revoke(claim.id);
			},
			Math.max(1, Number((claim.expires - process.hrtime.bigint()) / 1_000_000n))
		);
		timer.unref();
		this.#leases.set(claim.id, {
			claim: { ...claim },
			queryHash,
			query: structuredClone(query),
			reader,
			release,
			active: 0,
			revoked: false,
			released: false,
			timer,
			drained,
			resolveDrained,
		});
	}

	resume(token: string, queryHash: string): { claim: FullTextCursorClaim; position: FullTextContinuationPosition } {
		const { lease: id, position } = this.#tokens.open(token, queryHash);
		const lease = this.#get(id, queryHash);
		return { claim: { ...lease.claim }, position };
	}

	seal(id: string, queryHash: string, position: FullTextContinuationPosition): string {
		this.#get(id, queryHash);
		return this.#tokens.seal(id, queryHash, position);
	}

	async read(
		id: string,
		queryHash: string,
		position: FullTextContinuationPosition,
		deadline: bigint
	): Promise<NativeFullTextSearchPageResult> {
		const lease = this.#get(id, queryHash);
		if (
			!Number.isSafeInteger(position.batchSize) ||
			position.batchSize < 1 ||
			position.batchSize > this.#maxNativePageSize ||
			!Number.isSafeInteger(position.consumed) ||
			position.consumed < 0 ||
			position.consumed > position.batchSize
		)
			throw new ClientError('Invalid full-text continuation page', 400);
		const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
		if (!Number.isSafeInteger(remaining) || remaining < 1)
			throw new ServerError('Full-text continuation exceeded its request budget', 503);
		lease.active++;
		try {
			const page = await lease.reader.searchPage(
				{ query: lease.query, limit: position.batchSize, continuation: position.boundary },
				{ remainingBudgetMilliseconds: Math.min(remaining, this.#maxNativeBudgetMilliseconds) }
			);
			this.#get(id, queryHash);
			if (position.consumed > page.hits.length || (page.hits.length === 0 && page.continuation !== undefined))
				throw new ServerError('Full-text continuation returned an invalid replay boundary', 500);
			if (process.hrtime.bigint() >= deadline)
				throw new ServerError('Full-text continuation exceeded its request budget', 503);
			return page;
		} finally {
			lease.active--;
			this.#releaseIfDrained(lease);
		}
	}

	close(token: string, queryHash: string): Promise<void> {
		const { lease } = this.#tokens.open(token, queryHash);
		this.#get(lease, queryHash);
		return this.revoke(lease);
	}

	revoke(id: string): Promise<void> {
		const lease = this.#leases.get(id);
		if (!lease) return Promise.resolve();
		lease.revoked = true;
		this.#leases.delete(id);
		clearTimeout(lease.timer);
		this.#releaseIfDrained(lease);
		return lease.drained;
	}

	revokeReader(reader: NativeFullTextReader): Promise<void> {
		const draining: Promise<void>[] = [];
		for (const [id, lease] of this.#leases) if (lease.reader === reader) draining.push(this.revoke(id));
		return Promise.all(draining).then(() => {});
	}

	#get(id: string, queryHash: string): Lease {
		const lease = this.#leases.get(id);
		if (!lease || lease.queryHash !== queryHash) throw expired();
		if (lease.claim.expires <= process.hrtime.bigint()) {
			void this.revoke(id);
			throw expired();
		}
		return lease;
	}

	#releaseIfDrained(lease: Lease): void {
		if (!lease.revoked || lease.released || lease.active !== 0) return;
		lease.released = true;
		try {
			lease.release();
		} finally {
			lease.resolveDrained();
		}
	}
}

function expired(): ClientError {
	return new ClientError('Full-text continuation expired; start a new search', 410);
}
