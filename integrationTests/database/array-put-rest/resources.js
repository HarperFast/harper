// Records what the per-element array-PUT dispatch handed a custom put() override, onto the record
// itself. Durable on purpose: a module-level array would be worker-local, and the read can land on a
// different worker than the write.
export class BatchEcho extends tables.Batch {
	put(record, target) {
		record.observedTargetId = target?.id ?? null;
		record.observedIsCollection = target?.isCollection === true;
		record.observedFoo = target?.get?.('foo') ?? null;
		record.observedCheckPermission = target?.checkPermission === true;
		return super.put(record, target);
	}
}
