import { createHash } from 'node:crypto';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { fullTextContinuationDeadline } from './fullTextContinuation.ts';
import { type FullTextSearchLimits, resolveFullTextSearchLimits } from './fullTextSearchLimits.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';

import { FULL_TEXT_CONTINUATION_PAGE } from './fullTextQueryProtocol.ts';
export { FULL_TEXT_CONTINUATION_PAGE, FULL_TEXT_CONTINUATION_VERSION } from './fullTextQueryProtocol.ts';

export type FullTextSearchPage<T = any> = T[] & {
	readonly continuation?: string;
	readonly complete: boolean;
	readonly expiresAt?: number;
};

export class FullTextContinuationPage {
	readonly token: true | string;
	readonly limit: number;
	readonly close: boolean;
	readonly queryHash: string;
	readonly deadline: bigint;
	readonly policy: FullTextSearchLimits;
	readonly ready = Promise.withResolvers<void>();
	loadEntries!: (entries: any[]) => any[];
	materialize!: (entries: any[]) => Promise<any[]>;
	readonly records: any[] = [];
	continuation?: string;
	expiresAt?: number;
	complete = false;

	constructor(target: any, identity: unknown) {
		const policy = resolveFullTextSearchLimits(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT));
		this.policy = policy;
		this.deadline = fullTextContinuationDeadline(policy);
		if (
			(target.continuation !== true && (typeof target.continuation !== 'string' || !target.continuation)) ||
			!Number.isSafeInteger(target.limit) ||
			target.limit < 1 ||
			target.limit > policy.maxPageSize ||
			(target.offset !== undefined && target.offset !== 0) ||
			target.count ||
			target.explain ||
			target.sync
		)
			throw new ClientError(
				`Full-text continuation requires a limit from 1 to ${policy.maxPageSize}, without offset, count, explain or sync`,
				400
			);
		if (
			target.closeContinuation !== undefined &&
			target.closeContinuation !== false &&
			(target.closeContinuation !== true || typeof target.continuation !== 'string')
		)
			throw new ClientError('closeContinuation requires an existing continuation token', 400);
		this.close = target.closeContinuation === true;
		this.token = target.continuation;
		this.limit = target.limit;
		this.queryHash = createHash('sha256')
			.update(JSON.stringify(canonical({ query: identity, limits: policy }, new Set())))
			.digest('hex');
		this.ready.promise.catch(() => {});
	}

	result(): FullTextSearchPage {
		Object.defineProperty(this.records, FULL_TEXT_CONTINUATION_PAGE, { value: true });
		Object.defineProperties(this.records, {
			continuation: { value: this.continuation },
			complete: { value: this.complete },
			expiresAt: { value: this.expiresAt },
			selectApplied: { value: true },
		});
		return this.records as FullTextSearchPage;
	}
}

function canonical(value: unknown, seen: Set<object>): unknown {
	if (value === undefined) return ['undefined'];
	if (value === null) return ['null'];
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new ClientError('Full-text continuation query numbers must be finite', 400);
		return ['number', Object.is(value, -0) ? '-0' : String(value)];
	}
	if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
	if (typeof value === 'bigint') return ['bigint', String(value)];
	if (typeof value !== 'object') throw new ClientError('Unsupported full-text continuation query value', 400);
	if (value instanceof Date) {
		if (!Number.isFinite(value.getTime()))
			throw new ClientError('Full-text continuation query dates must be valid', 400);
		return ['date', value.toISOString()];
	}
	if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64url')];
	if (seen.has(value)) throw new ClientError('Full-text continuation query cannot be circular', 400);
	seen.add(value);
	try {
		const array = Array.isArray(value);
		if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			throw new ClientError('Unsupported full-text continuation query object', 400);
		const entries = Object.keys(value)
			.sort()
			.map((key) => [key, canonical(value[key], seen)]);
		return array ? ['array', value.length, entries] : ['object', entries];
	} finally {
		seen.delete(value);
	}
}
