// Loaded by contentTypes.ts, which the storage layer loads early: keep this free of resource imports.
import {
	ClientError,
	DatabaseGenerationChangedError,
	ResumeHistoryUnavailableError,
} from '../../utility/errors/hdbError.ts';
import type { SubscriptionCheckpoint } from '../../resources/subscriptionCheckpoint.ts';

/** What the event-stream serializer keeps about the ids of one built-in Table stream. */
export interface EventStreamCursor {
	/** Once the client holds a checkpoint token, a scalar id would replace it with a weaker position. */
	holdsToken: boolean;
	/** LMDB has no database generation to bind a log key to; elsewhere a key without one is never issued. */
	bareLogKeys: boolean;
}

export const EVENT_STREAM_CURSOR = Symbol('event-stream-cursor');

// well under the default 16 KB request header limit, which the id shares with every other header
const MAX_EVENT_ID_LENGTH = 4096;
const SCALAR_ID = /^(\d+(?:\.\d+)?)(?:@([0-9a-f]{32}))?$/;
const TOKEN_ID = /^[A-Za-z0-9_-]+$/;

/** A log key, with the database generation it was issued in when the engine has one, or a checkpoint to validate. */
type EventId = { key: number; generation?: string } | { checkpoint: unknown };

function unrecognizedEventId(): ClientError {
	return new ClientError(
		'Last-Event-ID is not an event id this resource issued; reconnect without it to resynchronize'
	);
}

/** Reads an id a built-in Table event stream issued; anything else is a 400. */
export function parseEventId(id: unknown): EventId {
	if (typeof id !== 'string' || id.length > MAX_EVENT_ID_LENGTH) throw unrecognizedEventId();
	const scalar = SCALAR_ID.exec(id);
	if (scalar) {
		const key = Number(scalar[1]);
		if (!(key > 0 && Number.isFinite(key))) throw unrecognizedEventId();
		return { key, generation: scalar[2] };
	}
	if (!TOKEN_ID.test(id)) throw unrecognizedEventId();
	try {
		return { checkpoint: JSON.parse(Buffer.from(id, 'base64url').toString()) };
	} catch {
		throw unrecognizedEventId();
	}
}

function encodeCheckpointId(checkpoint: SubscriptionCheckpoint): string | undefined {
	const id = Buffer.from(JSON.stringify(checkpoint)).toString('base64url');
	if (id.length <= MAX_EVENT_ID_LENGTH) return id;
}

/**
 * The per-event serializer of a built-in Table event stream. A checkpoint event, which the subscription queues
 * behind every event it covers, becomes a frame with only an `id`. Until the client holds one, each logged
 * event carries its own log key as the id; a snapshot row never does, since it is state and not a position.
 */
export function tableEventSerializer(
	subscription: any,
	cursor: EventStreamCursor,
	serialize: (message: any) => string
): (message: any) => string {
	// a position delivered before a checked resume is verified could hide history pruned below it
	let verified = subscription.resumeVerified === undefined;
	subscription.resumeVerified?.then((resumeVerified: boolean) => (verified = resumeVerified));
	const generation: string | undefined = subscription.databaseGeneration;
	return (message) => {
		if (message?.type === 'checkpoint' && message.checkpoint) {
			const id = encodeCheckpointId(message.checkpoint);
			// an SSE comment: the client keeps the id it has
			if (!id) return ':\n\n';
			cursor.holdsToken = true;
			return `id: ${id}\n\n`;
		}
		const key = message?.localTime;
		if (typeof key !== 'number' || message.fromScan || cursor.holdsToken || !verified) return serialize(message);
		if (!generation && !cursor.bareLogKeys) return serialize(message);
		// the event may be shared with other subscribers, so the id goes on an envelope
		return serialize({ data: message, id: generation ? `${key}@${generation}` : String(key) });
	};
}

/** Whether a stream ended because its position can no longer be served, so the id the client holds is void. */
export function voidsEventId(error: unknown): boolean {
	return error instanceof ResumeHistoryUnavailableError || error instanceof DatabaseGenerationChangedError;
}
