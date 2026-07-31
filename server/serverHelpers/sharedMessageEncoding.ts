import { serializeMessage, getMessageSerializer } from './contentTypes.ts';

/**
 * The encoding work that every subscriber of a topic would otherwise redo for the same message.
 * `payload` is the serialized message body; `frames` holds fully encoded protocol frames that are
 * byte-identical across subscribers (MQTT QoS 0 PUBLISH packets), keyed by whatever the frame
 * still varies on. `next` chains the encodings for any further content types the same message was
 * delivered in — a chain rather than a map because a topic's subscribers realistically negotiate
 * one or two content types, and this keeps the single-content-type case to one allocation.
 */
export interface SharedMessageEncoding {
	serializer: Function;
	payload: Buffer | string | Promise<Buffer | string>;
	frames: Map<string, Buffer> | undefined;
	next: SharedMessageEncoding | undefined;
}

// A fan-out has a single shared origin: the same message object instance is dispatched to every
// subscription of a key (resources/transactionBroadcast.ts), so identity is what lets the first
// subscriber to encode do the work for all of them. Identity implies equal content — a changed
// record decodes to a new object — so a miss (a primitive message, or a store cache eviction
// between subscribers) only costs the redundant encode we have today, it never yields stale bytes.
const sharedEncodings = new WeakMap<object, SharedMessageEncoding>();

function encode(message: any, request: any, serializer: Function): SharedMessageEncoding {
	const payload = serializeMessage(message, request);
	const encoding: SharedMessageEncoding = { serializer, payload, frames: undefined, next: undefined };
	// collapse an async serialization in place so later subscribers, and frame sharing, see the
	// finished buffer rather than re-entering the async path
	if ((payload as any)?.then)
		encoding.payload = (payload as Promise<Buffer | string>).then((resolved) => (encoding.payload = resolved));
	return encoding;
}

/**
 * Get the encoding shared by every subscriber that negotiated the same content type. Keyed on the
 * serializer function itself, which is the only thing `serializeMessage` output varies on.
 */
export function getSharedMessageEncoding(message: any, request?: any): SharedMessageEncoding {
	const serializer = getMessageSerializer(request);
	// primitives can not key a WeakMap, and are cheap to encode anyway; these stay per-subscriber
	if (message === null || typeof message !== 'object') return encode(message, request, serializer);
	let encoding = sharedEncodings.get(message);
	if (encoding === undefined) {
		sharedEncodings.set(message, (encoding = encode(message, request, serializer)));
		return encoding;
	}
	let last: SharedMessageEncoding;
	do {
		if (encoding.serializer === serializer) return encoding;
		last = encoding;
		encoding = encoding.next;
	} while (encoding !== undefined);
	return (last.next = encode(message, request, serializer));
}

/**
 * Get a fully encoded frame shared across subscribers, generating it on first use. `key` must cover
 * everything the frame varies on beyond the shared payload.
 */
export function getSharedFrame(encoding: SharedMessageEncoding, key: string, generateFrame: () => Buffer): Buffer {
	let frames = encoding.frames;
	if (frames === undefined) encoding.frames = frames = new Map();
	let frame = frames.get(key);
	if (frame === undefined) frames.set(key, (frame = generateFrame()));
	return frame;
}
