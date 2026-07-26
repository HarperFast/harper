const staticResourceTargets = new WeakMap<object, number>();

export function markStaticResourceTarget(target: object): void {
	staticResourceTargets.set(target, (staticResourceTargets.get(target) ?? 0) + 1);
}

export function unmarkStaticResourceTarget(target: object): void {
	const count = staticResourceTargets.get(target);
	if (count === 1) staticResourceTargets.delete(target);
	else if (count) staticResourceTargets.set(target, count - 1);
}

export function isStaticResourceTarget(target: unknown): boolean {
	return target != null && typeof target === 'object' && (staticResourceTargets.get(target) ?? 0) > 0;
}
