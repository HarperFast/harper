const staticResourceInstances = new WeakSet<object>();

// getResource creates a fresh receiver for every static dispatch. Keeping the marker on that
// receiver preserves the modern (target, message) signature across copied targets and delayed
// delegation without exposing reusable authorization state on caller-owned objects.
export function markStaticResourceInstance(resource: object): void {
	staticResourceInstances.add(resource);
}

export function isStaticResourceInstance(resource: object): boolean {
	return staticResourceInstances.has(resource);
}
