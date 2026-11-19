// Fixture for sse-resume.test.ts: a resource with its own event stream, which reads the reconnect
// header itself instead of getting the table's ids.
export class Cursor extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, request) {
		yield { event: 'cursor', data: { lastEventId: request.lastEventId ?? null }, id: 'cursor-1' };
	}
}
