// Scheduled job handler for the scheduler integration test. Each run inserts a
// row; the random id surfaces duplicate fires (two workers or two nodes running
// the same occurrence would produce two rows for the same tick).
export async function recordTick(context) {
	await tables.SchedulerTick.put({
		id: `${context.jobName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		jobName: context.jobName,
		catchUp: context.catchUp,
	});
}
