/**
 * Token bucket: starts full at `burst`, refills at `rate` tokens per
 * second up to `burst`, drained one token per `tryConsume()`. A caller that
 * already read the clock passes `now` instead of reading it again.
 */
export class TokenBucket {
	private rate: number;
	private burst: number;
	private tokens: number;
	private lastRefill: number;
	private clock: () => number;
	constructor(rate: number, burst: number, clock: () => number = Date.now, now: number = clock()) {
		this.rate = rate;
		this.burst = burst;
		this.tokens = burst;
		this.clock = clock;
		this.lastRefill = now;
	}
	tryConsume(now: number = this.clock()): boolean {
		this.refill(now);
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}
	/** Apply a changed rate/burst without refunding tokens already spent. */
	reconfigure(rate: number, burst: number): void {
		if (rate === this.rate && burst === this.burst) return;
		this.refill(this.clock());
		this.rate = rate;
		this.burst = burst;
		this.tokens = Math.min(this.tokens, burst);
	}
	isFull(now: number = this.clock()): boolean {
		this.refill(now);
		return this.tokens >= this.burst;
	}
	/**
	 * Refill-and-check, without consuming. Used to peek each of several
	 * buckets so a denial doesn't burn a token in *another* bucket.
	 */
	hasToken(): boolean {
		this.refill(this.clock());
		return this.tokens >= 1;
	}
	private refill(t: number): void {
		const elapsedSec = (t - this.lastRefill) / 1000;
		this.lastRefill = t;
		if (elapsedSec <= 0) return;
		this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rate);
	}
}

/**
 * The key a per-source-address limit buckets `address` under: IPv4 (a trailing port dropped), an
 * IPv4-mapped IPv6 address as its IPv4 form, and any other IPv6 address as its /64, the block a
 * single client is typically assigned.
 */
export function sourceAddressKey(identity: string): string {
	// the forms a socket reports for nearly every client, without the general path's allocations
	if (DOTTED_IPV4.test(identity)) return identity;
	if (MAPPED_IPV4.test(identity)) return identity.slice(7);
	const address = identity
		.replace(/^\[|\](:\d+)?$/g, '')
		.split('%')[0]
		.toLowerCase();
	const ipv4WithPort = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
	if (ipv4WithPort) return ipv4WithPort[1];
	if (!address.includes(':')) return address;
	const groups = expandIpv6(address);
	if (!groups) return address;
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
	}
	return `${groups
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(':')}::/64`;
}

const DOTTED_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAPPED_IPV4 = /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i;

function expandIpv6(address: string): number[] | undefined {
	const dotted = address.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (dotted) {
		const [, prefix, a, b, c, d] = dotted;
		address = `${prefix}${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`;
	}
	const [head, tail, extra] = address.split('::');
	if (extra !== undefined) return undefined;
	const headGroups = head ? head.split(':') : [];
	const tailGroups = tail ? tail.split(':') : [];
	const fill = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
	if (fill < 0) return undefined;
	const groups = [...headGroups, ...Array(fill).fill('0'), ...tailGroups].map((group) =>
		/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN
	);
	return groups.length === 8 && groups.every((group) => group >= 0) ? groups : undefined;
}
