import { Resource } from '../../resources/Resource.ts';
import { ORIGIN_FLOOR_TICK_MS } from '../../resources/originClosedFloor.ts';
import { positionBefore } from '../../resources/subscriptionCheckpoint.ts';
import { EVENT_STREAM_CURSOR, parseEventId, type EventStreamCursor } from './eventStreamIds.ts';

// floors are captured once per tick, so a shorter interval finds nothing new
let checkpointInterval = ORIGIN_FLOOR_TICK_MS;
/** Test-only: how often a built-in Table event stream looks for a new checkpoint to issue as its id. */
export function setEventStreamCheckpointIntervalForTests(milliseconds: number = ORIGIN_FLOOR_TICK_MS) {
	checkpointInterval = milliseconds;
}

/**
 * Whether an event stream of this resource is the table's own subscription, unseen by application code: an
 * overriding `connect` or `subscribe` would receive checkpoint events it never asked for, and may issue ids
 * of its own that must not be read as positions.
 */
export function usesTableSubscription(resource: any): boolean {
	if (resource?.connect !== Resource.connect || resource.prototype?.connect !== Resource.prototype.connect) {
		return false;
	}
	let owner = resource;
	while (owner?.prototype && !Object.hasOwn(owner.prototype, 'subscribe')) owner = Object.getPrototypeOf(owner);
	// the class makeTable() built owns its store
	return Boolean(owner?.prototype) && Object.hasOwn(owner, 'primaryStore');
}

/**
 * Makes the subscription behind a built-in Table event stream report its progress, and admits the request's
 * `Last-Event-ID` as the position it resumes from. The subscription itself refuses a position it cannot serve.
 */
export function resumeTableEventStream(resource: any, target: any, request: any): void {
	if (!usesTableSubscription(resource)) return;
	const cursor: EventStreamCursor = { holdsToken: false };
	target.reportProgress = true;
	target.checkpointInterval = checkpointInterval;
	const lastEventId = request.headers.asObject['last-event-id'];
	if (lastEventId) {
		const id = parseEventId(lastEventId);
		if ('checkpoint' in id) {
			target.resume = id.checkpoint;
			cursor.holdsToken = true;
		} else {
			// every record of a transaction can share the key, and the replay starts after its position
			target.startTime = positionBefore(id.key);
			if (id.generation) target.databaseGeneration = id.generation;
		}
	}
	request[EVENT_STREAM_CURSOR] = cursor;
}
