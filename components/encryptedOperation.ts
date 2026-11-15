/**
 * `encrypted_operation`: run an operation sealed to this node's secrets custody key and seal its
 * result, so a relay between the client and the node carries opaque bytes. Wire format and the
 * reference client: utility/sealedOperation.ts. Invariants: server/DESIGN.md.
 */
import { isMainThread } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import * as env from '../utility/environment/environmentManager.ts';
import * as terms from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { ClientError, ServerError } from '../utility/errors/hdbError.ts';
import { getSecretCustody, type SecretCustody } from '../resources/secretDecryptor.ts';
import { ENV_ENCRYPTED_PREFIX } from '../utility/envFile.ts';
import { parseEnvelopeFields } from '../utility/secretEnvelope.ts';
import {
	NONCE_BYTES,
	OPERATION_HASH_BYTES,
	RESPONSE_KEY_BYTES,
	SEALED_LEAF_KEY,
	SEALED_OPERATION_VERSION,
	decodeBase64,
	hashOperationText,
	openValue,
	pointerToken,
	sealResponse,
	type SealedMode,
	type SealedResult,
} from '../utility/sealedOperation.ts';
import { streamAsJSON } from '../server/serverHelpers/JSONStream.ts';
import { operationErrorResponse } from '../server/serverHelpers/operationErrorResponse.ts';
import { setOperationLogView, type OperationLogView } from '../utility/operationLogView.ts';
import { isOperationAuthorizationBypassed } from '../server/serverHelpers/operationAuthorizationState.ts';
import * as validator from './operationsValidation.ts';

const operationLog = harperLogger.loggerWithTag('operation');
const { OPERATIONS_ENUM, CONFIG_PARAMS } = terms;

const DEFAULT_MAX_AGE_MS = 300_000;
const MIN_MAX_AGE_MS = 1_000;
const MAX_MAX_AGE_MS = 600_000;
const DEFAULT_MAX_SIZE = 16 * 1024 * 1024;
const MIN_MAX_SIZE = 1024;
// A result is buffered and sealed whole, holding about four copies at once on the main thread.
const MAX_MAX_SIZE = 64 * 1024 * 1024;
// A fields-mode envelope carries only the header: keys, nonce, timestamp, actor and a hash.
const FIELDS_ENVELOPE_MAX_LENGTH = 16 * 1024;
const MAX_DEPTH = 64;
const MAX_SEALED_LEAVES = 10_000;
const MAX_ACTOR_LENGTH = 256;
let maxReservedNonces = 100_000;

// Set by the transport or by dispatch, never by a caller; a sealed body carrying one is refused.
const REFUSED_INNER_FIELDS = [
	'hdb_user',
	'hdbAuthHeader',
	'bypass_auth',
	'bypassAuth',
	'impersonate',
	'baseRequest',
	'baseResponse',
	'fastifyResponse',
	'progress',
];
// Each authenticates its own caller or sets a session cookie; refresh-token Bearer selection also keys
// off the outer operation name (security/fastifyAuth.ts), which here is always encrypted_operation.
const REFUSED_INNER_OPERATIONS: ReadonlySet<string> = new Set([
	OPERATIONS_ENUM.ENCRYPTED_OPERATION,
	OPERATIONS_ENUM.LOGIN,
	OPERATIONS_ENUM.LOGOUT,
	OPERATIONS_ENUM.EXCHANGE_OIDC_TOKEN,
	OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN,
]);

interface OperationDispatch {
	chooseOperation(body: any, bypassAuth?: boolean): Function;
	processLocalTransaction(req: { body: any }, operationFunction: Function): Promise<any>;
	isJobOperation(operation: string): boolean;
}

let dispatch: OperationDispatch | undefined;

/** Injected by serverUtilities, which imports this module; a static import back would be a cycle. */
export function setEncryptedOperationDispatch(operationDispatch: OperationDispatch): void {
	dispatch = operationDispatch;
}

interface SealedHeader {
	v: number;
	rk: string;
	nonce: string;
	ts: number;
	actor?: string;
	op?: Record<string, any>;
	oph?: string;
}

/** Refuses the sealed operation; answered inside the sealed response, never in plaintext. */
class SealedRefusal extends Error {
	statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.statusCode = statusCode;
	}
}

// Nonce -> reservation. Per process: a restart forgets it (see server/DESIGN.md).
const reservedNonces = new Map<string, { expiry: number; principal: string }>();
const reservationsByPrincipal = new Map<string, number>();
let monotonicNow = () => performance.now();
let wallNow = () => Date.now();

export function _setClocksForTest(clocks?: { monotonic?: () => number; wall?: () => number }): void {
	monotonicNow = clocks?.monotonic ?? (() => performance.now());
	wallNow = clocks?.wall ?? (() => Date.now());
}

export function _resetReservedNoncesForTest(limit = 100_000): void {
	reservedNonces.clear();
	reservationsByPrincipal.clear();
	maxReservedNonces = limit;
}

function configuredInteger(param: string, fallback: number, min: number, max: number): number {
	const raw = env.get(param);
	const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
	return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/** `actor` is attribution written to the log, so no control characters (no forged log lines). */
function isLoggableActor(actor: unknown): boolean {
	if (typeof actor !== 'string' || actor.length > MAX_ACTOR_LENGTH) return false;
	for (let index = 0; index < actor.length; index++) {
		const code = actor.charCodeAt(index);
		if (code < 32 || code === 127) return false;
	}
	return true;
}

function isPlainObject(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A plaintext refusal whose body carries a field the client acts on (`custody_fingerprint`, `server_time`). */
class AdmissionRefusal extends ClientError {
	http_resp_msg: Record<string, unknown>;
	constructor(message: string, statusCode: number, detail: Record<string, unknown>) {
		super(message, statusCode);
		this.http_resp_msg = { error: message, ...detail };
	}
}

/**
 * Run a sealed operation. Failures before the request's nonce is reserved answer in plaintext with
 * constant messages; everything after is sealed under the request's response key.
 */
export async function encryptedOperation(req: any) {
	const maxSize = configuredInteger(
		CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE,
		DEFAULT_MAX_SIZE,
		MIN_MAX_SIZE,
		MAX_MAX_SIZE
	);
	const maxAge = configuredInteger(
		CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE,
		DEFAULT_MAX_AGE_MS,
		MIN_MAX_AGE_MS,
		MAX_MAX_AGE_MS
	);
	const mode: SealedMode = req?.mode === 'fields' ? 'fields' : 'sealed';
	const envelopeLimit = mode === 'fields' ? FIELDS_ENVELOPE_MAX_LENGTH : maxSize;
	if (typeof req?.envelope === 'string' && req.envelope.length > envelopeLimit) {
		throw new ClientError('The envelope exceeds the encrypted operation size limit', 413);
	}
	if (typeof req?.op === 'string' && req.op.length > maxSize) {
		throw new ClientError('The operation exceeds the encrypted operation size limit', 413);
	}
	const validation = validator.encryptedOperationValidator(req);
	if (validation) throw new ClientError(validation.message, 400);
	if (!isMainThread) throw new ClientError('encrypted_operation runs only through the operations API', 400);
	const bypassAuth = isOperationAuthorizationBypassed();
	if (!req.hdb_user && !bypassAuth) throw new ClientError('encrypted_operation requires an authenticated caller', 401);
	const custody = getSecretCustody();
	if (!custody) throw new ClientError('secrets custody is not initialized on this node', 503);
	if (!dispatch) throw new ServerError('encrypted_operation is not available in this process', 503);

	const { header, kid, responseKey, operationHash } = openHeader(req.envelope, custody, mode);
	const now = wallNow();
	if (Math.abs(now - header.ts) > maxAge) {
		throw new AdmissionRefusal('The sealed request is outside the accepted time window', 400, { server_time: now });
	}
	// No maxAge, even one raised later, admits the envelope once the wall clock passes ts + MAX_MAX_AGE_MS.
	reserveNonce(header.nonce, header.ts + MAX_MAX_AGE_MS - now, req.hdb_user?.username ?? '');

	let answer: { status: number; plaintext: Buffer };
	try {
		answer = await runSealedOperation(req, header, mode, kid, responseKey, operationHash, maxSize, bypassAuth);
	} catch (error) {
		operationLog.error(`encrypted_operation: unexpected ${error?.constructor?.name ?? typeof error} (sealed request)`);
		answer = sealedResult({ status: 500, body: { error: 'The sealed operation failed' } }, maxSize);
	}
	const sealed = sealResponse(answer.plaintext, responseKey, header.nonce);
	return mode === 'fields' ? { status: answer.status, encrypted_response: sealed } : { encrypted_response: sealed };
}

function openHeader(envelope: string, custody: SecretCustody, mode: SealedMode) {
	let kid: string | undefined;
	try {
		kid = parseEnvelopeFields(envelope.slice(ENV_ENCRYPTED_PREFIX.length)).kid;
	} catch {
		throw new ClientError('The envelope is malformed', 400);
	}
	if (!kid) throw new ClientError("The envelope must carry a 'kid'", 400);
	let text: string;
	try {
		text = custody.decrypt(envelope);
	} catch {
		const { fingerprint } = custody.getPublicKey();
		if (kid !== fingerprint) {
			throw new AdmissionRefusal("The envelope's kid does not match this node's secrets key", 409, {
				custody_fingerprint: fingerprint,
			});
		}
		throw new ClientError('The envelope could not be decrypted', 400);
	}
	let header: SealedHeader;
	try {
		header = JSON.parse(text);
	} catch {
		throw new ClientError('The sealed request is malformed', 400);
	}
	if (!isPlainObject(header)) throw new ClientError('The sealed request is malformed', 400);
	const responseKey = decodeBase64(header.rk, RESPONSE_KEY_BYTES);
	const operationHash = mode === 'fields' ? decodeBase64(header.oph, OPERATION_HASH_BYTES) : undefined;
	if (
		header.v !== SEALED_OPERATION_VERSION ||
		!responseKey ||
		!decodeBase64(header.nonce, NONCE_BYTES) ||
		typeof header.ts !== 'number' ||
		!Number.isFinite(header.ts) ||
		(header.actor !== undefined && !isLoggableActor(header.actor)) ||
		(mode === 'fields'
			? header.op !== undefined || !operationHash
			: header.oph !== undefined || !isPlainObject(header.op))
	) {
		throw new ClientError('The sealed request is malformed', 400);
	}
	return { header, kid, responseKey, operationHash };
}

/** Reserve before anything runs and never release, so a duplicate is refused even if the first failed. */
function reserveNonce(nonce: string, admissibleFor: number, principal: string): void {
	const now = monotonicNow();
	pruneReservedNonces(now, false);
	if (reservedNonces.has(nonce)) throw new ClientError('This sealed request was already received', 409);
	if (!hasReplayCapacity(principal)) {
		// Expiries follow each envelope's ts, not insertion order; a full sweep reclaims what the front prune skipped.
		pruneReservedNonces(now, true);
		if (!hasReplayCapacity(principal)) {
			throw new ClientError('Too many sealed requests in the replay window; retry later', 503);
		}
	}
	reservedNonces.set(nonce, { expiry: now + admissibleFor + 1, principal });
	reservationsByPrincipal.set(principal, (reservationsByPrincipal.get(principal) ?? 0) + 1);
}

/**
 * Past half the store, a principal may hold only an equal share of that half, so one caller flooding
 * envelopes (even ones it may not run) leaves the other half to everyone else.
 */
function hasReplayCapacity(principal: string): boolean {
	const size = reservedNonces.size;
	if (size >= maxReservedNonces) return false;
	if (size < maxReservedNonces / 2) return true;
	const held = reservationsByPrincipal.get(principal) ?? 0;
	const holders = reservationsByPrincipal.size + (held === 0 ? 1 : 0);
	return held < maxReservedNonces / 2 / holders;
}

function pruneReservedNonces(now: number, fullSweep: boolean): void {
	for (const [nonce, { expiry, principal }] of reservedNonces) {
		if (expiry <= now) {
			reservedNonces.delete(nonce);
			const held = reservationsByPrincipal.get(principal) - 1;
			if (held > 0) reservationsByPrincipal.set(principal, held);
			else reservationsByPrincipal.delete(principal);
		} else if (!fullSweep) break;
	}
}

async function runSealedOperation(
	req: any,
	header: SealedHeader,
	mode: SealedMode,
	kid: string,
	responseKey: Buffer,
	operationHash: Buffer | undefined,
	maxSize: number,
	bypassAuth: boolean
): Promise<{ status: number; plaintext: Buffer }> {
	const metadata: Record<string, unknown> = { mode, kid };
	if (header.actor !== undefined) metadata.actor = header.actor;
	let inner: Record<string, any>;
	let buildView: () => Record<string, unknown>;
	try {
		if (mode === 'fields') {
			inner = openFields(req.op, header.nonce, responseKey, operationHash);
			buildView = () => ({ ...maskSealedLeaves(JSON.parse(req.op)), encrypted_operation: metadata });
		} else {
			inner = header.op;
			visit(inner, '', 0, { sealable: false, responseKey, nonce: header.nonce, leaves: 0 });
			buildView = () => ({ operation: inner.operation, encrypted_operation: metadata });
		}
		checkInnerOperation(inner);
		// A job stores its request and result in system.hdb_job, where get_job reads them back unsealed.
		if (dispatch.isJobOperation(inner.operation)) {
			throw new SealedRefusal(`'${inner.operation}' runs as a stored job; use a direct connection`);
		}
	} catch (error) {
		if (!(error instanceof SealedRefusal)) throw error;
		return sealedResult({ status: error.statusCode, body: { error: error.message } }, maxSize);
	}

	inner.hdb_user = req.hdb_user;
	let view: Record<string, unknown> | undefined;
	const logView: OperationLogView = () => (view ??= buildView());
	setOperationLogView(inner, logView);
	let result: any;
	try {
		const operationFunction = dispatch.chooseOperation(inner, bypassAuth);
		result = await dispatch.processLocalTransaction({ body: inner }, operationFunction);
	} catch (error) {
		const { statusCode, body } = operationErrorResponse(error);
		return sealedResult({ status: statusCode, body }, maxSize);
	}

	if (result instanceof Readable || typeof result?.pipe === 'function') {
		try {
			result.on?.('error', () =>
				operationLog.warn(`encrypted_operation: a discarded result stream of '${inner.operation}' errored`)
			);
		} catch {}
		try {
			result.destroy?.();
		} catch {}
		return sealedResult(
			{
				status: 406,
				body: { error: `'${inner.operation}' returned a byte stream; use a direct connection` },
				executed: true,
			},
			maxSize
		);
	}
	let chunks: Buffer[] | undefined;
	try {
		chunks = await collectJSON(result, maxSize - SUCCESS_PREFIX.length - SUCCESS_SUFFIX.length);
	} catch {
		return sealedResult(
			{ status: 500, body: { error: 'The result could not be serialized' }, executed: true },
			maxSize
		);
	}
	if (chunks === undefined) {
		return sealedResult(
			{
				status: 413,
				body: { error: `The result exceeds ${maxSize} bytes; use a direct connection` },
				executed: true,
			},
			maxSize
		);
	}
	return {
		status: 200,
		plaintext: Buffer.concat([SUCCESS_PREFIX, ...(chunks.length ? chunks : [NULL_JSON]), SUCCESS_SUFFIX]),
	};
}

const SUCCESS_PREFIX = Buffer.from('{"status":200,"body":');
const SUCCESS_SUFFIX = Buffer.from('}');
const NULL_JSON = Buffer.from('null');

function sealedResult(result: SealedResult, maxSize: number): { status: number; plaintext: Buffer } {
	let json: string | undefined;
	let fallback: string | undefined;
	try {
		json = JSON.stringify(result);
		if (Buffer.byteLength(json) > maxSize) fallback = `The error exceeds ${maxSize} bytes`;
	} catch {
		fallback = 'The error could not be serialized';
	}
	if (fallback !== undefined) {
		json = JSON.stringify({
			status: result.status,
			body: { error: fallback },
			...(result.executed ? { executed: true } : {}),
		});
	}
	return { status: result.status, plaintext: Buffer.from(json, 'utf8') };
}

function openFields(opText: string, nonce: string, responseKey: Buffer, operationHash: Buffer): Record<string, any> {
	if (!timingSafeEqual(Buffer.from(hashOperationText(opText), 'base64'), operationHash)) {
		throw new SealedRefusal('The visible operation does not match the sealed request');
	}
	let visible: unknown;
	try {
		visible = JSON.parse(opText);
	} catch {
		throw new SealedRefusal("'op' is not valid JSON");
	}
	if (!isPlainObject(visible) || typeof visible.operation !== 'string') {
		throw new SealedRefusal("The visible operation must name its 'operation' in plaintext");
	}
	return visit(visible, '', 0, { sealable: true, responseKey, nonce, leaves: 0 });
}

interface WalkContext {
	sealable: boolean;
	responseKey: Buffer;
	nonce: string;
	leaves: number;
}

/**
 * Depth-limited walk over a JSON value that opens sealed leaves (fields mode) and refuses the
 * prototype-poisoning shapes Fastify's body parser refuses on the plaintext path, since this JSON never
 * passed through it. An opened value is checked but not opened again: `$sealed` inside it is data, and
 * the JSON Pointer is tracked only where a sealed leaf can occur.
 */
function visit(value: any, pointer: string, depth: number, context: WalkContext): any {
	if (value === null || typeof value !== 'object') return value;
	if (depth > MAX_DEPTH) throw new SealedRefusal('The operation is nested too deeply');
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			value[index] = visit(value[index], context.sealable ? `${pointer}/${index}` : pointer, depth + 1, context);
		}
		return value;
	}
	if (context.sealable && Object.hasOwn(value, SEALED_LEAF_KEY)) {
		const sealed = value[SEALED_LEAF_KEY];
		if (typeof sealed !== 'string' || Object.keys(value).length !== 1) {
			throw new SealedRefusal(`A sealed value must be an object with only a string '${SEALED_LEAF_KEY}'`);
		}
		if (++context.leaves > MAX_SEALED_LEAVES) throw new SealedRefusal('The operation has too many sealed values');
		let opened: unknown;
		try {
			opened = openValue(sealed, context.responseKey, context.nonce, pointer);
		} catch {
			throw new SealedRefusal(`The sealed value at '${pointer}' could not be opened`);
		}
		return visit(opened, pointer, depth, { ...context, sealable: false });
	}
	for (const key of Object.keys(value)) {
		if (key === '__proto__') throw new SealedRefusal('The operation contains a forbidden property name');
		// checked after visiting, so a sealed leaf cannot hide `prototype` from it
		const childPointer = context.sealable ? `${pointer}/${pointerToken(key)}` : pointer;
		const child = visit(value[key], childPointer, depth + 1, context);
		if (key === 'constructor' && isPlainObject(child) && Object.hasOwn(child, 'prototype')) {
			throw new SealedRefusal('The operation contains a forbidden property name');
		}
		value[key] = child;
	}
	return value;
}

function checkInnerOperation(inner: Record<string, any>): void {
	if (typeof inner.operation !== 'string' || inner.operation === '') {
		throw new SealedRefusal("The sealed operation must name an 'operation'");
	}
	for (const property of terms.PROTOTYPE_POLLUTING_NAMES) {
		if (Object.hasOwn(inner, property)) throw new SealedRefusal(`Request body property "${property}" is not allowed`);
	}
	for (const field of REFUSED_INNER_FIELDS) {
		if (Object.hasOwn(inner, field)) throw new SealedRefusal(`A sealed operation may not set '${field}'`);
	}
	if (REFUSED_INNER_OPERATIONS.has(inner.operation)) {
		throw new SealedRefusal(`'${inner.operation}' cannot run inside encrypted_operation`);
	}
	if (terms.STREAMING_RESPONSE_OPERATIONS.has(inner.operation)) {
		throw new SealedRefusal(`'${inner.operation}' returns a byte stream; use a direct connection`, 406);
	}
}

function maskSealedLeaves(value: any): any {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(maskSealedLeaves);
	if (Object.hasOwn(value, SEALED_LEAF_KEY)) return '[sealed]';
	const masked: Record<string, unknown> = {};
	for (const key of Object.keys(value)) masked[key] = maskSealedLeaves(value[key]);
	return masked;
}

/** The JSON the plaintext path would send, as chunks, or undefined past `maxSize` bytes. */
function collectJSON(result: unknown, maxSize: number): Promise<Buffer[] | undefined> {
	const stream = streamAsJSON(result);
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		stream.on('data', (chunk: Buffer | string) => {
			if (settled) return;
			size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
			if (size > maxSize) {
				settled = true;
				resolve(undefined);
				stream.destroy();
				return;
			}
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		});
		stream.on('end', () => {
			if (settled) return;
			settled = true;
			resolve(chunks);
		});
		stream.on('error', (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		stream.on('close', () => {
			if (settled) return;
			settled = true;
			reject(new Error('The result stream closed before it ended'));
		});
	});
}
