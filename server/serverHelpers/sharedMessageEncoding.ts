import { serializeMessage, getMessageSerializer } from './contentTypes.ts';

/**
 * The encoding work that every subscriber of a topic would otherwise redo for the same message.
 * `payload` is the serialized message body; `frames` holds fully encoded protocol frames that are
 * byte-identical across subscribers (MQTT QoS 0 PUBLISH packets), keyed by whatever the frame
 * still varies on. `next` chains the encodings for any further content types the same message was
 * delivered in — a chain rather than a map because a topic's subscribers realistically negotiate
 * one or two content types, and this keeps the single-content-type case to one allocation.
 * A `payload` of undefined means the last attempt failed and the next subscriber should retry.
 */
export interface SharedMessageEncoding {
	serializer: Function;
	payload: Buffer | string | Promise<Buffer | string> | undefined;
	frames: Map<number, Map<string, Buffer>> | undefined;
	next: SharedMessageEncoding | undefined;
}

// A message that carries its own content type is passed through verbatim and never negotiated, so
// every subscriber shares one entry no matter what it negotiated. This sentinel stands in for the
// serializer that was deliberately not consulted.
const PASS_THROUGH = function passThrough() {};

// A fan-out has a single shared origin: the same message object instance is dispatched to every
// subscription of a key (resources/transactionBroadcast.ts), so identity is what lets the first
// subscriber to encode do the work for all of them. Identity implies equal content — a changed
// record decodes to a new object — so a miss (a primitive message, or a store cache eviction
// between subscribers) only costs the redundant encode we have today, it never yields stale bytes.
//
// Retention is bounded by rotating generations rather than by the message object's lifetime: for
// record events the message IS the store's cached record, so hanging encodings off it alone would
// keep serialized copies and whole PUBLISH buffers resident for as long as the record stays cached,
// while sharing is only ever needed for the duration of one fan-out. Two generations are kept so a
// fan-out spanning a rotation still hits; dropping a generation releases all of it at once.
const ROTATE_INTERVAL_MS = 10_000;
// deliveries between clock checks — Date.now() per delivery would itself be hot-path cost
const ROTATE_CHECK_INTERVAL = 256;
let currentGeneration = new WeakMap<object, SharedMessageEncoding>();
let previousGeneration = new WeakMap<object, SharedMessageEncoding>();
let rotatedAt = Date.now();
let sinceRotationCheck = 0;

function maybeRotate() {
	if (++sinceRotationCheck < ROTATE_CHECK_INTERVAL) return;
	sinceRotationCheck = 0;
	const now = Date.now();
	if (now - rotatedAt < ROTATE_INTERVAL_MS) return;
	rotatedAt = now;
	previousGeneration = currentGeneration;
	currentGeneration = new WeakMap();
}

function fill(encoding: SharedMessageEncoding, message: any, request: any) {
	encoding.frames = undefined;
	const payload = serializeMessage(message, request);
	encoding.payload = payload;
	if ((payload as any)?.then)
		// collapse an async serialization in place so later subscribers, and frame sharing, see the
		// finished buffer rather than re-entering the async path
		encoding.payload = (payload as Promise<Buffer | string>).then(
			(resolved) => (encoding.payload = resolved),
			(error) => {
				// clear rather than memoize the failure: a shared rejected promise would turn one
				// transient serialization error into a permanent one for every later subscriber
				encoding.payload = undefined;
				throw error;
			}
		);
}

function encode(message: any, request: any, serializer: Function): SharedMessageEncoding {
	const encoding: SharedMessageEncoding = { serializer, payload: undefined, frames: undefined, next: undefined };
	fill(encoding, message, request);
	return encoding;
}

/**
 * Get the encoding shared by every subscriber that negotiated the same content type. Keyed on the
 * serializer function itself, which is the only thing `serializeMessage` output varies on.
 */
export function getSharedMessageEncoding(message: any, request?: any): SharedMessageEncoding {
	// Negotiation must not run for a pass-through message: an Accept header naming only unsupported
	// types throws 406, which would kill a delivery that used to succeed by returning message.data.
	const serializer =
		message?.contentType != null && message.data != null ? PASS_THROUGH : getMessageSerializer(request);
	// primitives can not key a WeakMap, and are cheap to encode anyway; these stay per-subscriber
	if (message === null || typeof message !== 'object') return encode(message, request, serializer);
	maybeRotate();
	let encoding = currentGeneration.get(message);
	if (encoding === undefined) {
		encoding = previousGeneration.get(message);
		if (encoding === undefined) {
			currentGeneration.set(message, (encoding = encode(message, request, serializer)));
			return encoding;
		}
		currentGeneration.set(message, encoding); // promote so it survives the next rotation
	}
	let last: SharedMessageEncoding;
	do {
		if (encoding.serializer === serializer) {
			if (encoding.payload === undefined) fill(encoding, message, request);
			return encoding;
		}
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

/** Store a generated frame for reuse by the remaining subscribers, and return it. */
export function setSharedFrame(encoding: SharedMessageEncoding, version: number, topic: string, frame: Buffer): Buffer {
	let frames = encoding.frames;
	if (frames === undefined) encoding.frames = frames = new Map();
	let byTopic = frames.get(version);
	if (byTopic === undefined) frames.set(version, (byTopic = new Map()));
	byTopic.set(topic, frame);
	return frame;
}
