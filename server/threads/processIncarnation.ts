import { randomBytes } from 'node:crypto';
import { workerData } from 'node:worker_threads';

export const processIncarnation: string | undefined = workerData
	? workerData.processIncarnation
	: randomBytes(8).toString('hex');
