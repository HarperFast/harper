import { PREPARE_DEFAULT_SUBSCRIPTION, Resource } from '../../resources/Resource.ts';
import { ORIGIN_FLOOR_TICK_MS } from '../../resources/originClosedFloor.ts';
import { positionBefore } from '../../resources/subscriptionCheckpoint.ts';
import { DatabaseGenerationChangedError } from '../../utility/errors/hdbError.ts';
import { EVENT_STREAM_CURSOR, parseEventId, type EventStreamCursor } from './eventStreamIds.ts';

// floors are captured once per tick, so a shorter interval finds nothing new
let checkpointInterval = ORIGIN_FLOOR_TICK_MS;
/** Test-only: how often a built-in Table event stream looks for a new checkpoint to issue as its id. */
export function setEventStreamCheckpointIntervalForTests(milliseconds: number = ORIGIN_FLOOR_TICK_MS) {
	checkpointInterval = milliseconds;
}

/**
 * The table class whose own subscription this resource's event stream is, unseen by application code. An
 * overriding `connect` or `subscribe`, on the class or the instance, would receive checkpoint events it never
 * asked for, and may issue ids of its own that must not be read as positions.
 */
function ownTableSubscription(resource: any): any {
	if (resource.connect !== Resource.prototype.connect) return;
	let tableClass = resource.constructor;
	// the class makeTable() built owns its store
	while (tableClass?.prototype && !Object.hasOwn(tableClass, 'primaryStore')) {
		tableClass = Object.getPrototypeOf(tableClass);
	}
	if (tableClass?.prototype && resource.subscribe === tableClass.prototype.subscribe) return tableClass;
}

/**
 * Makes the subscription behind a built-in Table event stream report its progress, and admits the request's
 * `Last-Event-ID` as the position it resumes from. The subscription itself refuses a position it cannot serve.
 */
function prepareTableSubscription(resource: any, target: any, request: any): void {
	const tableClass = ownTableSubscription(resource);
	if (!tableClass) return;
	const cursor: EventStreamCursor = { holdsToken: false, bareLogKeys: tableClass.storageEngine !== 'rocksdb' };
	target.reportProgress = true;
	target.checkpointInterval = checkpointInterval;
	if (request.lastEventId) {
		const id = parseEventId(request.lastEventId);
		if ('checkpoint' in id) {
			target.resume = id.checkpoint;
			cursor.holdsToken = true;
		} else {
			// RocksDB issues no log key without its generation, and could not check one that came without
			if (!id.generation && !cursor.bareLogKeys) throw new DatabaseGenerationChangedError();
			// every record of a transaction can share the key, and the replay starts after its position
			target.startTime = positionBefore(id.key);
			if (id.generation) target.databaseGeneration = id.generation;
		}
	}
	request[EVENT_STREAM_CURSOR] = cursor;
}

/** Lets the default `connect()` of an event-stream request prepare a table's own subscription for resuming. */
export function resumeTableEventStream(resource: any, request: any): void {
	if (resource?.connect === Resource.connect) request[PREPARE_DEFAULT_SUBSCRIPTION] = prepareTableSubscription;
}
