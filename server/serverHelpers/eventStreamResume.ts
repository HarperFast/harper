import { createHash } from 'node:crypto';
import { PREPARE_DEFAULT_SUBSCRIPTION, Resource } from '../../resources/Resource.ts';
import { isTableSubscribe } from '../../resources/Table.ts';
import { getDatabaseGeneration } from '../../resources/auditStore.ts';
import { ORIGIN_FLOOR_TICK_MS } from '../../resources/originClosedFloor.ts';
import { positionBefore } from '../../resources/subscriptionCheckpoint.ts';
import { DatabaseGenerationChangedError } from '../../utility/errors/hdbError.ts';
import { EVENT_STREAM_CURSOR, parseEventId, type EventStreamCursor } from './eventStreamIds.ts';

// floors are captured once per tick, so a shorter interval finds nothing new
let checkpointInterval = ORIGIN_FLOOR_TICK_MS;
export function setEventStreamCheckpointIntervalForTests(milliseconds: number = ORIGIN_FLOOR_TICK_MS) {
	checkpointInterval = milliseconds;
}

/**
 * What a log key of this table is only a position in: this database generation, and this incarnation of this
 * table. A restored database, another node, another table or one dropped and created again has another.
 */
function logKeyScope(tableClass: any): string | undefined {
	if (tableClass.storageEngine !== 'rocksdb') return '';
	const generation = getDatabaseGeneration(tableClass.auditStore)?.id;
	if (!generation) return;
	const table = createHash('sha256')
		.update(`${tableClass.tableName}\0${tableClass.storageGeneration ?? ''}`)
		.digest('hex');
	return `@${generation}.${table.slice(0, 16)}`;
}

/**
 * Makes the subscription behind a built-in Table event stream report its progress, and admits the request's
 * `Last-Event-ID` as the position it resumes from. The subscription itself refuses a position it cannot serve.
 */
function prepareTableSubscription(resource: any, target: any, request: any): void {
	const cursor: EventStreamCursor = { holdsToken: false, logKeyScope: logKeyScope(resource.constructor) };
	target.reportProgress = true;
	target.checkpointInterval = checkpointInterval;
	if (request.lastEventId) {
		const id = parseEventId(request.lastEventId);
		if ('checkpoint' in id) {
			target.resume = id.checkpoint;
			cursor.holdsToken = true;
		} else {
			if (id.scope !== cursor.logKeyScope) throw new DatabaseGenerationChangedError();
			// every record of a transaction can share the key, and the replay starts after its position
			target.startTime = positionBefore(id.key);
			if (id.scope) target.databaseGeneration = id.scope.slice(1, 33);
		}
	}
	request[EVENT_STREAM_CURSOR] = cursor;
}

/**
 * Lets the default `connect()` of an event-stream request prepare a table's own subscription for resuming. An
 * overriding `connect` or `subscribe`, however it is declared, would receive checkpoint events it never asked
 * for, and may issue ids of its own that must not be read as positions. So would any other stream opened with
 * this request, which is why the hook waits for the dispatch of the request's own target on its own resource.
 */
export function resumeTableEventStream(matched: any, matchedTarget: any, request: any): void {
	if (matched?.connect !== Resource.connect) return;
	request[PREPARE_DEFAULT_SUBSCRIPTION] = (resource: any, target: any) => {
		if (target !== matchedTarget) return;
		if (resource.constructor !== matched && resource.constructor !== matched.Collection) return;
		request[PREPARE_DEFAULT_SUBSCRIPTION] = undefined;
		if (
			resource.connect === Resource.prototype.connect &&
			isTableSubscribe(resource.subscribe) &&
			// a path extension can choose another format than the Accept header
			(request.requestedContentType ?? 'text/event-stream') === 'text/event-stream'
		) {
			prepareTableSubscription(resource, target, request);
		}
	};
}
