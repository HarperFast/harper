import { ClientError } from '../../utility/errors/hdbError.ts';

const etagBytes = new Uint8Array(8);
const etagFloat = new Float64Array(etagBytes.buffer);
const HTTP_DATE =
	/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

export function versionToEtag(version: number): string {
	etagFloat[0] = version;
	return String.fromCharCode(
		34,
		(etagBytes[0] & 0x3f) + 62,
		(etagBytes[0] >> 6) + ((etagBytes[1] << 2) & 0x3f) + 62,
		(etagBytes[1] >> 4) + ((etagBytes[2] << 4) & 0x3f) + 62,
		(etagBytes[2] >> 2) + 62,
		(etagBytes[3] & 0x3f) + 62,
		(etagBytes[3] >> 6) + ((etagBytes[4] << 2) & 0x3f) + 62,
		(etagBytes[4] >> 4) + ((etagBytes[5] << 4) & 0x3f) + 62,
		(etagBytes[5] >> 2) + 62,
		(etagBytes[6] & 0x3f) + 62,
		(etagBytes[6] >> 6) + ((etagBytes[7] << 2) & 0x3f) + 62,
		34
	);
}

export function parseHttpDate(value: unknown): number | undefined {
	if (typeof value !== 'string' || !HTTP_DATE.test(value)) return;
	const parts = value.replace(/[,-]/g, ' ').split(/\s+/);
	const asctime = !value.includes(',');
	const day = +parts[asctime ? 2 : 1];
	const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(
		parts[asctime ? 1 : 2]
	);
	let year = +parts[asctime ? 4 : 3];
	let futureLimit: Date | undefined;
	if (parts[asctime ? 4 : 3].length === 2) {
		futureLimit = new Date();
		const currentYear = futureLimit.getUTCFullYear();
		futureLimit.setUTCFullYear(currentYear + 50);
		year += Math.floor(currentYear / 100) * 100;
		if (year > currentYear + 50) year -= 100;
	}
	const [hour, minute, second] = parts[asctime ? 3 : 4].split(':').map(Number);
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, second, 0);
	if (futureLimit && date > futureLimit) date.setUTCFullYear((year -= 100));
	if (
		month >= 0 &&
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month &&
		date.getUTCDate() === day &&
		hour < 24 &&
		minute < 60 &&
		second < 60
	)
		return date.getTime();
}

function matchesEtag(value: string | string[], etag: string | undefined, exists: boolean, weak: boolean): boolean {
	const list = Array.isArray(value) ? value.join(',') : value;
	if (list.trim() === '*') return exists;
	const comparable = weak && etag?.startsWith('W/') ? etag.slice(2) : etag;
	let matched = false;
	let offset = 0;
	while (offset < list.length) {
		while (list[offset] === '\t' || list[offset] === ' ' || list[offset] === ',') offset++;
		if (offset === list.length) break;
		const start = offset;
		const weakTag = list.startsWith('W/', offset);
		if (weakTag) offset += 2;
		const tagStart = offset;
		if (list[offset++] !== '"') throw new ClientError('Invalid entity-tag precondition');
		while (offset < list.length && list[offset] !== '"') {
			const code = list.charCodeAt(offset++);
			if (code < 0x21 || code > 0xff || code === 0x7f) throw new ClientError('Invalid entity-tag precondition');
		}
		if (list[offset++] !== '"') throw new ClientError('Invalid entity-tag precondition');
		const tag = list.slice(weak ? tagStart : start, offset);
		if (exists && comparable && (weak || !weakTag) && tag === comparable) matched = true;
		while (list[offset] === ' ' || list[offset] === '\t') offset++;
		if (offset < list.length && list[offset++] !== ',') throw new ClientError('Invalid entity-tag precondition');
	}
	return matched;
}

export function hasWritePreconditions(headers: Record<string, any>): boolean {
	return (
		headers['if-match'] !== undefined ||
		headers['if-none-match'] !== undefined ||
		parseHttpDate(headers['if-unmodified-since']) !== undefined
	);
}

export function hasPreconditions(headers: Record<string, any>): boolean {
	return (
		headers['if-match'] !== undefined ||
		headers['if-none-match'] !== undefined ||
		headers['if-modified-since'] !== undefined ||
		headers['if-unmodified-since'] !== undefined
	);
}

export function evaluatePreconditions(
	headers: Record<string, any>,
	method: string,
	exists: boolean,
	etag?: string,
	lastModified?: number
): 304 | 412 | undefined {
	const read = method === 'GET' || method === 'HEAD';
	if (headers['if-match'] !== undefined) {
		if (!matchesEtag(headers['if-match'], etag, exists, false)) return 412;
	} else if (exists && Number.isFinite(lastModified)) {
		const unmodifiedSince = parseHttpDate(headers['if-unmodified-since']);
		if (unmodifiedSince !== undefined && Math.floor(lastModified / 1000) > unmodifiedSince / 1000) return 412;
	}
	if (headers['if-none-match'] !== undefined) {
		if (matchesEtag(headers['if-none-match'], etag, exists, true)) return read ? 304 : 412;
	} else if (read && exists && Number.isFinite(lastModified)) {
		const modifiedSince = parseHttpDate(headers['if-modified-since']);
		if (modifiedSince !== undefined && Math.floor(lastModified / 1000) <= modifiedSince / 1000) return 304;
	}
}
