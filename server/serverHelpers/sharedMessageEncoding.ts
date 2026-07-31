import { serializeMessage, getMessageSerializer } from './contentTypes.ts';

/**
 * The encoding work that every subscriber of a topic would otherwise redo for the same message.
 * `payload` is the serialized message body; `frames` holds fully encoded protocol frames that are
 * byte-identical across subscribers (MQTT QoS 0 PUBLISH packets), keyed by whatever the frame
 * still varies on. `next` chains the encodings for any further content types the same message was
 * delivered in — a chain rather than a map because a topic's subscribers realistically negotiate
 * one or two content types, and this keeps the single-content-type case to one allocation.
 *
 * `hits` counts the subscribers after the first, so a caller can skip caching anything derived
 * from the payload until a fan-out is known to exist. `failed` is a distinct state from an
 * undefined `payload`, which a serializer can legitimately return (JSON of `undefined`).
 */
export interface SharedMessageEncoding {
	serializer: Function;
	payload: Buffer | string | Promise<Buffer | string> | undefined;
	failed: boolean;
	hits: number;
	frames: Map<number, Map<string, Buffer>> | undefined;
	next: SharedMessageEncoding | undefined;
}

// A message that carries its own content type is passed through verbatim and never negotiated, so
// every subscriber shares one entry no matter what it negotiated. This sentinel stands in for the
// serializer that was deliberately not consulted.
const PASS_THROUGH = function passThrough() {};

// THE IDENTITY CONTRACT. A fan-out has a single shared origin: the same message object instance is
// dispatched to every subscription of a key (resources/transactionBroadcast.ts), so identity is
// what lets the first subscriber to encode do the work for all of them. This is only sound because
// every internal producer yields a *fresh object per version* — transactionBroadcast hands one
// auditRecord to every subscription, auditStore's getValue memoizes the decode in its closure, and
// primaryStore.getEntry is guarded by a version check — so identity implies equal content, and a
// miss (a primitive message, or a store cache eviction between subscribers) only costs the
// redundant encode we have today rather than yielding stale bytes.
//
// A custom Resource that sends a MUTABLE object it later mutates in place and re-sends breaks that
// contract and would deliver the earlier bytes. Emit a new object per message instead of reusing
// one envelope — the same rule record objects already follow.
//
// Retention is bounded by rotating generations rather than by the message object's lifetime: for
// record events the message IS the store's cached record, so hanging encodings off it alone would
// keep serialized copies and whole PUBLISH buffers resident for as long as the record stays cached,
// while sharing is only ever needed for the duration of one fan-out. Two generations are kept so a
// fan-out spanning a rotation still hits; dropping a generation releases all of it at once.
const ROTATE_INTERVAL_MS = 10_000;
let currentGeneration = new WeakMap<object, SharedMessageEncoding>();
let previousGeneration = new WeakMap<object, SharedMessageEncoding>();
// Rotation runs on a timer, not on a delivery counter: the bound has to hold when traffic stops,
// which is exactly when a delivery-gated check would never fire again. Insert counts only decide
// when the timer can stop — a WeakMap can not be asked whether it is empty.
let rotationTimer: ReturnType<typeof setInterval> | undefined;
let currentInserts = 0;

/** Retire the older generation. Exported for the rotation timer and for tests. */
export function rotateSharedEncodings() {
	previousGeneration = currentGeneration;
	currentGeneration = new WeakMap();
	const rotatedInserts = currentInserts;
	currentInserts = 0;
	if (rotatedInserts === 0 && rotationTimer !== undefined) {
		// nothing is retained in either generation, so stop ticking until the next insert
		clearInterval(rotationTimer);
		rotationTimer = undefined;
	}
}

function retain(message: object, encoding: SharedMessageEncoding) {
	currentGeneration.set(message, encoding);
	currentInserts++;
	if (rotationTimer === undefined) {
		rotationTimer = setInterval(rotateSharedEncodings, ROTATE_INTERVAL_MS);
		rotationTimer.unref?.();
	}
}

function fill(encoding: SharedMessageEncoding, message: any, request: any) {
	encoding.frames = undefined;
	encoding.failed = false;
	const payload = serializeMessage(message, request);
	encoding.payload = payload;
	if ((payload as any)?.then)
		// collapse an async serialization in place so later subscribers, and frame sharing, see the
		// finished buffer rather than re-entering the async path
		encoding.payload = (payload as Promise<Buffer | string>).then(
			(resolved) => (encoding.payload = resolved),
			(error) => {
				// mark for retry rather than memoize the failure: a shared rejected promise would turn
				// one transient serialization error into a permanent one for every later subscriber
				encoding.failed = true;
				encoding.payload = undefined;
				throw error;
			}
		);
}

function encode(message: any, request: any, serializer: Function): SharedMessageEncoding {
	const encoding: SharedMessageEncoding = {
		serializer,
		payload: undefined,
		failed: false,
		hits: 0,
		frames: undefined,
		next: undefined,
	};
	fill(encoding, message, request);
	return encoding;
}

function reuse(encoding: SharedMessageEncoding, message: any, request: any): SharedMessageEncoding {
	encoding.hits++;
	if (encoding.failed) fill(encoding, message, request);
	return encoding;
}

/**
 * Get the encoding shared by every subscriber that negotiated the same content type. Keyed on the
 * serializer function itself, which is what `serializeMessage` output varies on.
 */
export function getSharedMessageEncoding(message: any, request?: any): SharedMessageEncoding {
	// Negotiation must not run for a pass-through message: an Accept header naming only unsupported
	// types throws 406, which would kill a delivery that used to succeed by returning message.data.
	const serializer =
		message?.contentType != null && message.data != null ? PASS_THROUGH : getMessageSerializer(request);
	// primitives can not key a WeakMap, and are cheap to encode anyway; these stay per-subscriber
	if (message === null || typeof message !== 'object') return encode(message, request, serializer);
	let encoding = currentGeneration.get(message);
	if (encoding === undefined) {
		encoding = previousGeneration.get(message);
		if (encoding === undefined) {
			retain(message, (encoding = encode(message, request, serializer)));
			return encoding;
		}
		retain(message, encoding); // promote so it survives the next rotation
	}
	let last: SharedMessageEncoding;
	do {
		if (encoding.serializer === serializer) return reuse(encoding, message, request);
		last = encoding;
		encoding = encoding.next;
	} while (encoding !== undefined);
	return (last.next = encode(message, request, serializer));
}

/**
 * Look up a fully encoded frame shared across subscribers, or undefined if it has not been
 * generated yet. Split from `setSharedFrame` so a cache hit — the whole point on a fan-out —
 * allocates nothing, not even a generator closure.
 */
export function getSharedFrame(encoding: SharedMessageEncoding, version: number, topic: string): Buffer | undefined {
	return encoding.frames?.get(version)?.get(topic);
}

/**
 * Store a generated frame for reuse by the remaining subscribers, and return it. Call only when
 * `encoding.hits > 0`: a frame stored for a fan-out of one is never read, and would keep a whole
 * PUBLISH buffer reachable from the message object for the rest of its retention window.
 */
export function setSharedFrame(encoding: SharedMessageEncoding, version: number, topic: string, frame: Buffer): Buffer {
	let frames = encoding.frames;
	if (frames === undefined) encoding.frames = frames = new Map();
	let byTopic = frames.get(version);
	if (byTopic === undefined) frames.set(version, (byTopic = new Map()));
	byTopic.set(topic, frame);
	return frame;
}
