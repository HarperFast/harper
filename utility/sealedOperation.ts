/**
 * Pure cryptography for `encrypted_operation`. Its only Harper import is `secretEnvelope.ts`, itself
 * dependency-free, so it is unit-testable alone and is the reference client.
 *
 * Request: `{ operation: 'encrypted_operation', envelope: 'enc:v1:…', mode?, op? }`. The envelope is
 * an ordinary `enc:v1` envelope sealed to the node's custody public key; its plaintext is the sealed
 * header `{ v, rk, nonce, ts, actor?, op? | oph? }`. In `sealed` mode the inner operation rides in the
 * header. In `fields` mode the outer body carries the operation as JSON text in `op`, the header
 * carries `oph`, the SHA-256 of that text, and any value may be a sealed leaf `{ "$sealed": … }`.
 *
 * Everything the node returns after admission is AES-256-GCM under the client-chosen `rk`, so only
 * the client and the node can read it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BASE64_REGEX, encryptEnvelope } from './secretEnvelope.ts';

export const SEALED_OPERATION_VERSION = 1;
export const SEALED_LEAF_KEY = '$sealed';
export const RESPONSE_KEY_BYTES = 32;
export const NONCE_BYTES = 16;
export const OPERATION_HASH_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const RESPONSE_AAD_PREFIX = 'harper.encrypted_operation.response:';
const FIELD_AAD_PREFIX = 'harper.encrypted_operation.field:';
const ENVELOPE_PREFIX = 'enc:v1:';
const DEFAULT_VISIBLE_FIELDS = ['database', 'schema', 'table'];

export type SealedMode = 'sealed' | 'fields';

export interface SealedPayload {
	v: number;
	iv: string;
	ct: string;
	tag: string;
}

export interface SealedResult {
	status: number;
	body: unknown;
	executed?: true;
}

/** Strict base64 to bytes, or undefined when the text is not base64 or not `byteLength` long. */
export function decodeBase64(value: unknown, byteLength?: number): Buffer | undefined {
	if (typeof value !== 'string' || !BASE64_REGEX.test(value)) return undefined;
	const bytes = Buffer.from(value, 'base64');
	return byteLength === undefined || bytes.length === byteLength ? bytes : undefined;
}

function responseAad(nonce: string): Buffer {
	return Buffer.from(RESPONSE_AAD_PREFIX + nonce, 'utf8');
}

function fieldAad(nonce: string, pointer: string): Buffer {
	return Buffer.from(`${FIELD_AAD_PREFIX}${nonce}:${pointer}`, 'utf8');
}

/** RFC 6901 reference token for one key. */
export function pointerToken(key: string | number): string {
	return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function hashOperationText(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('base64');
}

function aesGcmSeal(plaintext: Buffer, key: Buffer, aad: Buffer) {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aad);
	// GCM is a stream mode: final() emits no bytes, so update() already holds the whole ciphertext.
	const ct = cipher.update(plaintext);
	cipher.final();
	return { iv, ct, tag: cipher.getAuthTag() };
}

function aesGcmOpen(iv: Buffer, ct: Buffer, tag: Buffer, key: Buffer, aad: Buffer): Buffer {
	const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
	decipher.setAAD(aad);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Seal the node's answer: `result` is the UTF-8 JSON of a {@link SealedResult}. */
export function sealResponse(result: string | Buffer, responseKey: Buffer, nonce: string): SealedPayload {
	const plaintext = typeof result === 'string' ? Buffer.from(result, 'utf8') : result;
	const { iv, ct, tag } = aesGcmSeal(plaintext, responseKey, responseAad(nonce));
	return {
		v: SEALED_OPERATION_VERSION,
		iv: iv.toString('base64'),
		ct: ct.toString('base64'),
		tag: tag.toString('base64'),
	};
}

/**
 * Open the node's answer. The decrypted `status` is authoritative; the plaintext `status` a fields-mode
 * reply also carries is for relays and is not authenticated. `executed: true` means the operation ran
 * but its result could not be delivered: do not resend a non-idempotent operation.
 */
export function openResponse(sealed: SealedPayload, responseKey: Buffer, nonce: string): SealedResult {
	const iv = decodeBase64(sealed?.iv, IV_BYTES);
	const ct = decodeBase64(sealed?.ct);
	const tag = decodeBase64(sealed?.tag, TAG_BYTES);
	if (sealed?.v !== SEALED_OPERATION_VERSION || !iv || !ct || !tag) throw new Error('malformed sealed response');
	const result = JSON.parse(aesGcmOpen(iv, ct, tag, responseKey, responseAad(nonce)).toString('utf8'));
	if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
		throw new Error('malformed sealed response');
	}
	return result;
}

/** Seal one value of a fields-mode operation; `pointer` is its RFC 6901 location within `op`. */
export function sealValue(value: unknown, responseKey: Buffer, nonce: string, pointer: string) {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError(`value at '${pointer}' has no JSON representation`);
	const { iv, ct, tag } = aesGcmSeal(Buffer.from(json, 'utf8'), responseKey, fieldAad(nonce, pointer));
	return { [SEALED_LEAF_KEY]: Buffer.concat([iv, ct, tag]).toString('base64') };
}

/** Open one sealed leaf; throws when it was tampered with or moved to another location. */
export function openValue(sealed: string, responseKey: Buffer, nonce: string, pointer: string): unknown {
	const bytes = decodeBase64(sealed);
	if (!bytes || bytes.length < IV_BYTES + TAG_BYTES) throw new Error('malformed sealed value');
	const iv = bytes.subarray(0, IV_BYTES);
	const ct = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
	const tag = bytes.subarray(bytes.length - TAG_BYTES);
	return JSON.parse(aesGcmOpen(iv, ct, tag, responseKey, fieldAad(nonce, pointer)).toString('utf8'));
}

export interface SealOperationOptions {
	op: Record<string, unknown> & { operation: string };
	publicKey: string;
	kid: string;
	mode?: SealedMode;
	/** fields mode: top-level keys left visible besides `operation` (default: database, schema, table). */
	visibleFields?: readonly string[];
	actor?: string;
	now?: number;
}

/**
 * Reference client: seal `op` for `encrypted_operation`. Returns the request body plus the response
 * key and nonce needed to {@link openResponse} the reply. In fields mode every top-level value outside
 * `visibleFields` becomes one sealed leaf.
 */
export function sealOperation({
	op,
	publicKey,
	kid,
	mode = 'sealed',
	visibleFields = DEFAULT_VISIBLE_FIELDS,
	actor,
	now = Date.now(),
}: SealOperationOptions) {
	const responseKey = randomBytes(RESPONSE_KEY_BYTES);
	const nonce = randomBytes(NONCE_BYTES).toString('base64');
	const header: Record<string, unknown> = {
		v: SEALED_OPERATION_VERSION,
		rk: responseKey.toString('base64'),
		nonce,
		ts: now,
	};
	if (actor !== undefined) header.actor = actor;
	const request: Record<string, unknown> = { operation: 'encrypted_operation' };
	if (mode === 'fields') {
		const visible: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(op)) {
			visible[key] =
				key === 'operation' || visibleFields.includes(key)
					? value
					: sealValue(value, responseKey, nonce, '/' + pointerToken(key));
		}
		const opText = JSON.stringify(visible);
		header.oph = hashOperationText(opText);
		request.mode = 'fields';
		request.op = opText;
	} else {
		header.op = op;
	}
	request.envelope = ENVELOPE_PREFIX + encryptEnvelope(JSON.stringify(header), publicKey, kid);
	return { request, responseKey, nonce };
}
