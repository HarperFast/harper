import { threadId } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';

declare const Resource: any;
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();

export class QualificationState extends Resource {
	allowRead(user) {
		return Boolean(user?.role?.permission?.super_user);
	}
	get() {
		const result = {
			pid: process.pid,
			threadId,
			rss: process.memoryUsage().rss,
			cpu: process.cpuUsage(),
			loopDelay: {
				p50: delay.percentile(50) / 1e6,
				p95: delay.percentile(95) / 1e6,
				p99: delay.percentile(99) / 1e6,
				max: delay.max / 1e6,
			},
		};
		delay.reset();
		return result;
	}
}
