import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';

const MAX_TOKEN_CHARACTERS = 16 * 1024;

type Route = { version: 1; process: string; owner: number; lease: string };
export type FullTextContinuationPosition = {
	boundary?: string;
	batchSize: number;
	consumed: number;
};

type Boundary = FullTextContinuationPosition & { query: string };

export class FullTextContinuationToken {
	readonly #routingKey: Buffer;
	readonly #ownerKey = randomBytes(32);
	readonly #process: string;
	readonly #owner: number;
	readonly #maxNativePageSize: number;

	constructor(routingKey: string, process: string, owner: number, maxNativePageSize: number) {
		this.#routingKey = Buffer.from(routingKey, 'base64url');
		if (
			this.#routingKey.length !== 32 ||
			!process ||
			process.length > 128 ||
			!Number.isSafeInteger(owner) ||
			owner < 0 ||
			!Number.isSafeInteger(maxNativePageSize) ||
			maxNativePageSize < 1
		)
			throw new Error('Full-text continuation routing is unavailable');
		this.#process = process;
		this.#owner = owner;
		this.#maxNativePageSize = maxNativePageSize;
	}

	seal(lease: string, query: string, position: FullTextContinuationPosition): string {
		if (
			!/^[a-f0-9]{32}$/.test(lease) ||
			!/^[a-f0-9]{64}$/.test(query) ||
			!validPosition(position, this.#maxNativePageSize)
		)
			throw new TypeError('Invalid full-text continuation boundary');
		const route: Route = { version: 1, process: this.#process, owner: this.#owner, lease };
		const header = Buffer.from(JSON.stringify(route)).toString('base64url');
		const nonce = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.#ownerKey, nonce);
		cipher.setAAD(Buffer.from(header));
		const body = Buffer.concat([
			nonce,
			cipher.update(JSON.stringify({ ...position, query })),
			cipher.final(),
			cipher.getAuthTag(),
		]).toString('base64url');
		const signed = `${header}.${body}`;
		const token = `${signed}.${this.#mac(signed).toString('base64url')}`;
		if (token.length > MAX_TOKEN_CHARACTERS)
			throw new ServerError('Full-text continuation exceeds its token byte limit', 500);
		return token;
	}

	route(token: string): Route {
		return this.#inspect(token).route;
	}

	open(token: string, query: string): { lease: string; position: FullTextContinuationPosition } {
		const { route, header, body } = this.#inspect(token);
		if (route.owner !== this.#owner) throw expired();
		try {
			const encrypted = Buffer.from(body, 'base64url');
			if (encrypted.length < 29) throw expired();
			const cipher = createDecipheriv('aes-256-gcm', this.#ownerKey, encrypted.subarray(0, 12));
			cipher.setAAD(Buffer.from(header));
			cipher.setAuthTag(encrypted.subarray(-16));
			const value = JSON.parse(
				Buffer.concat([cipher.update(encrypted.subarray(12, -16)), cipher.final()]).toString()
			) as Boundary;
			if (!validPosition(value, this.#maxNativePageSize) || value.query !== query) throw expired();
			return {
				lease: route.lease,
				position: { boundary: value.boundary, batchSize: value.batchSize, consumed: value.consumed },
			};
		} catch {
			throw expired();
		}
	}

	#inspect(token: string): { route: Route; header: string; body: string } {
		if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARACTERS) throw expired();
		const parts = token.split('.');
		if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw expired();
		const [header, body, signature] = parts;
		if (header.length > 512 || signature.length !== 43) throw expired();
		const expected = this.#mac(`${header}.${body}`);
		const actual = Buffer.from(signature, 'base64url');
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw expired();
		try {
			const route = JSON.parse(Buffer.from(header, 'base64url').toString()) as Route;
			if (
				route.version !== 1 ||
				route.process !== this.#process ||
				!Number.isSafeInteger(route.owner) ||
				route.owner < 0 ||
				typeof route.lease !== 'string' ||
				!/^[a-f0-9]{32}$/.test(route.lease)
			)
				throw expired();
			return { route, header, body };
		} catch {
			throw expired();
		}
	}

	#mac(value: string): Buffer {
		return createHmac('sha256', this.#routingKey).update(value).digest();
	}
}

function validPosition(value: FullTextContinuationPosition, maxNativePageSize: number): boolean {
	return (
		!!value &&
		typeof value === 'object' &&
		(value.boundary === undefined ||
			(typeof value.boundary === 'string' && value.boundary.length <= MAX_TOKEN_CHARACTERS)) &&
		Number.isSafeInteger(value.batchSize) &&
		value.batchSize > 0 &&
		value.batchSize <= maxNativePageSize &&
		Number.isSafeInteger(value.consumed) &&
		value.consumed >= 0 &&
		value.consumed <= value.batchSize
	);
}

function expired(): ClientError {
	return new ClientError('Full-text continuation expired or is invalid; start a new search', 410);
}
