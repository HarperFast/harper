import { EventEmitter } from 'events';

/**
 * Set on a queue class whose end() always closes it (emitting 'close'), so a consumer that listens for
 * 'close' need not also wrap end().
 */
export const CLOSES_WHEN_ENDED = Symbol('closesWhenEnded');

/**
 * Holds an emitter's listeners by event name, as Node's `_events` does. Node creates that as a
 * `{ __proto__: null }` literal, which V8 keeps in dictionary mode at about 180 bytes per emitter; an
 * instance of this has the same lookups (its prototype chain is empty) as an ordinary fast object,
 * and EventEmitter's methods work on it unchanged.
 */
function EventSlots() {}
EventSlots.prototype = Object.create(null);

export class IterableEventQueue<Event extends object = any> extends EventEmitter {
	resolveNext: null | ((args: IteratorResult<Event>) => void) = null;
	queue: any[];
	// fields set only on some paths are declared, not defined, so a queue that never takes those paths
	// has no slot for them (a live subscription is one of these queues)
	declare hasDataListeners: boolean;
	closed = false;
	declare closedWith: Event | undefined;
	declare drainCloseListener: boolean;
	declare currentDrainResolver: null | ((draining: boolean) => void);
	/** Pending waitForDrain calls; with none, an empty read has no one to tell. */
	drainWaiters = 0;
	/**
	 * A consumer that pulls with getNextMessage() rather than iterating: woken when a message is queued
	 * while the queue was empty, and expected to read until getNextMessage() returns undefined.
	 */
	consumer: { wake(): void } | null = null;
	constructor() {
		super();
		(this as any)._events = new (EventSlots as any)();
	}
	[Symbol.asyncIterator](): AsyncIterator<Event> {
		const iterator = new EventQueueIterator<Event>();
		iterator.queue = this;
		// @ts-expect-error The EventQueueIterator is acceptable as an AsyncIterator
		return iterator;
	}
	push(message: Event) {
		return this.send(message);
	}
	send(message: Event) {
		if (this.closed) return false;
		if (this.resolveNext) {
			this.resolveNext({ value: message, done: false });
			this.resolveNext = null;
		} else if (this.hasDataListeners) {
			this.emit('data', message);
		} else {
			if (!this.queue) this.queue = [];
			if (this.queue.push(message) === 1) this.consumer?.wake();
		}
		return true;
	}
	/**
	 * Permanently close the queue. A final message is delivered before iteration ends when supplied. The queue
	 * closes and emits 'close' once even if a listener throws on the final message; that error is then rethrown.
	 */
	close(finalMessage?: Event) {
		if (this.closed) return;
		// Closing is authoritative: buffered events must not leak after revocation or policy failure.
		if (this.queue) this.queue.length = 0;
		this.closedWith = finalMessage;
		try {
			if (finalMessage !== undefined) this.send(finalMessage);
		} finally {
			// a listener handling the final message may already have closed the queue
			if (!this.closed) {
				this.closed = true;
				if (this.resolveNext) {
					this.resolveNext({ value: undefined, done: true });
					this.resolveNext = null;
				}
				this.emit('close');
			}
		}
	}
	getNextMessage() {
		const message = this.queue?.shift();
		if (!message && this.drainWaiters > 0) this.emit('drained');
		return message;
	}

	/**
	 * Wait for the queue to be drained, resolving to true to continue or false if the queue was closed before draining.
	 */
	waitForDrain(): Promise<boolean> {
		return new Promise((resolve) => {
			if (this.closed) resolve(false);
			else if (!this.queue || this.queue.length === 0) resolve(true);
			else {
				// The queue can also empty through paths that never emit 'drained' (the on('data')
				// attach loop and the resolveNext bypass), so a waiter relying on the event alone
				// can hang forever on an already-empty queue. Poll as a fallback wakeup.
				let settled = false;
				const settle = (drained: boolean) => {
					clearInterval(poll);
					this.removeListener('drained', onDrained);
					if (!settled) {
						settled = true;
						this.drainWaiters--;
					}
					resolve(drained);
				};
				const onDrained = () => settle(true);
				this.drainWaiters++;
				this.once('drained', onDrained);
				this.currentDrainResolver = settle;
				const poll = setInterval(() => {
					if (!this.queue || this.queue.length === 0) settle(true);
				}, 100);
				poll.unref?.();
				if (!this.drainCloseListener) {
					this.drainCloseListener = true;
					this.on('close', () => {
						this.currentDrainResolver?.(false);
					});
				}
			}
		});
	}
	on(eventName: 'data' | string, listener: ((data: Event) => void) | any) {
		if (eventName === 'data' && !this.hasDataListeners) {
			this.hasDataListeners = true;
			while (this.queue?.length > 0) listener(this.queue.shift());
		}
		return super.on(eventName, listener);
	}
	// `hasDataListeners` gates whether `send()` emits 'data' or buffers; keep it in
	// step with reality when a 'data' listener is removed (e.g. an MCP SSE stream
	// torn down on disconnect). Without this it stayed stuck on `true` for the life
	// of the queue once any 'data' listener had ever attached.
	removeListener(eventName: 'data' | string, listener: (...args: any[]) => void) {
		const result = super.removeListener(eventName, listener);
		if (eventName === 'data') this.hasDataListeners = this.listenerCount('data') > 0;
		return result;
	}
	// `EventEmitter.off` is a direct alias of the *base* `removeListener`, so it
	// would bypass the override above (and SSE teardown unsubscribes via `off`).
	// Route it through our `removeListener` so the flag is recomputed either way.
	off(eventName: 'data' | string, listener: (...args: any[]) => void) {
		return this.removeListener(eventName, listener);
	}
}

class EventQueueIterator<Event extends object = any> implements AsyncIterator<Event> {
	queue: IterableEventQueue<Event>;
	push(message: Event) {
		this.queue.send(message);
	}
	// @ts-expect-error TypeScript is wrong, the JS engine accepts MaybePromise<...>
	next(): IteratorResult<Event> | Promise<IteratorResult<Event>> {
		const message = this.queue.getNextMessage();
		if (message !== undefined) {
			return {
				value: message,
				done: false,
			};
		} else if (this.queue.closed) {
			return { value: undefined, done: true };
		} else {
			return new Promise((resolve) => (this.queue.resolveNext = resolve));
		}
	}
	// @ts-expect-error TypeScript is wrong, the JS engine accepts MaybePromise<...>
	return(value: Event): { value: Event; done: true } {
		this.queue.close();
		return {
			value,
			done: true,
		};
	}
	// @ts-expect-error TypeScript is wrong, the JS engine accepts MaybePromise<...>
	throw(_error) {
		this.queue.close();
		return {
			done: true,
			value: undefined,
		};
	}
}
