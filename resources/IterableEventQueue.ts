import { EventEmitter } from 'events';

export class IterableEventQueue extends EventEmitter {
	resolveNext: Function;
	queue: any[];
	hasDataListeners: boolean;
	drainCloseListener: boolean;
	currentDrainResolver: Function;
	[Symbol.asyncIterator]() {
		const iterator = new EventQueueIterator();
		iterator.queue = this;
		return iterator;
	}
	push(message) {
		this.send(message);
	}
	send(message: any) {
		if (this.resolveNext) {
			this.resolveNext({ value: message });
			this.resolveNext = null;
		} else if (this.hasDataListeners) {
			this.emit('data', message);
		} else {
			if (!this.queue) this.queue = [];
			this.queue.push(message);
		}
	}
	getNextMessage() {
		const message = this.queue?.shift();
		if (!message) this.emit('drained');
		return message;
	}

	/**
	 * Wait for the queue to be drained, resolving to true to continue or false if the queue was closed before draining.
	 */
	waitForDrain(): Promise<boolean> {
		return new Promise((resolve) => {
			if (!this.queue || this.queue.length === 0) resolve(true);
			else {
				this.once('drained', () => resolve(true));
				this.currentDrainResolver = resolve;
				if (!this.drainCloseListener) {
					this.drainCloseListener = true;
					this.on('close', () => {
						this.currentDrainResolver?.(false);
					});
				}
			}
		});
	}
	on(eventName, listener) {
		if (eventName === 'data' && !this.hasDataListeners) {
			this.hasDataListeners = true;
			while (this.queue?.length > 0) listener(this.queue.shift());
		}
		return super.on(eventName, listener);
	}
}

class EventQueueIterator {
	queue: IterableEventQueue;
	push(message) {
		this.queue.send(message);
	}
	next() {
		const message = this.queue.getNextMessage();
		if (message) {
			return {
				value: message,
			};
		} else {
			return new Promise((resolve) => (this.queue.resolveNext = resolve));
		}
	}
	return(value) {
		this.queue.emit('close');
		return {
			value,
			done: true,
		};
	}
	throw(error) {
		this.queue.emit('close', error);
		return {
			done: true,
		};
	}
}
