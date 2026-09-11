export class PendingRequests {
	#failures: unknown[] = [];
	#pending = new Set<Promise<void>>();

	get failed(): boolean {
		return this.#failures.length > 0;
	}

	get size(): number {
		return this.#pending.size;
	}

	add(request: Promise<unknown>): void {
		let tracked: Promise<void>;
		tracked = request
			.then(
				() => undefined,
				(error) => {
					this.#failures.push(error);
				}
			)
			.finally(() => this.#pending.delete(tracked));
		this.#pending.add(tracked);
	}

	async waitForOne(): Promise<void> {
		await Promise.race(this.#pending);
	}

	async drain(workload: string): Promise<void> {
		await Promise.all(this.#pending);
		if (this.#failures.length > 0) {
			throw new AggregateError(this.#failures, `${workload} failed for ${this.#failures.length} request(s)`);
		}
	}
}
