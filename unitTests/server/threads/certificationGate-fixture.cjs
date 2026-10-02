'use strict';

// A stand-in HTTP worker for the certification gate. A worker started held (workerData.certify) reports the
// verdict its turn in the plan file names, then binds — here, announces it started — only once admitted.

const { appendFileSync, readFileSync } = require('node:fs');
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');

const planPath = process.env.CERTIFICATION_GATE_PLAN;

let step;
parentPort.on('message', (message) => {
	if (message?.type === ITC_EVENT_TYPES.SHUTDOWN) setTimeout(() => process.exit(0), 20);
	else if (message?.type === ITC_EVENT_TYPES.CHILD_ADMITTED) {
		if (step?.afterAdmission === 'exit') process.exit(4);
		parentPort.postMessage({ type: ITC_EVENT_TYPES.CHILD_STARTED });
	}
});
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-booted', threadId, certify: workerData.certify ?? null });

if (!workerData.certify) {
	parentPort.postMessage({ type: ITC_EVENT_TYPES.CHILD_STARTED });
} else {
	const plan = JSON.parse(readFileSync(planPath, 'utf8'));
	appendFileSync(`${planPath}.starts`, `${threadId}\n`);
	const turn = readFileSync(`${planPath}.starts`, 'utf8').trim().split('\n').length - 1;
	step = plan.sequence[Math.min(turn, plan.sequence.length - 1)];
	setTimeout(() => {
		if (step.behavior === 'exit') process.exit(3);
		if (step.behavior === 'silent') return;
		parentPort.postMessage({
			type: ITC_EVENT_TYPES.CHILD_COMPONENT_VERDICT,
			components: workerData.certify.map(({ component, deploymentId }) => ({
				component,
				outcome: step.outcome,
				failures:
					step.outcome === 'failed' ? [{ key: `${component}.rest`, name: 'Error', message: 'threw at load' }] : [],
				loadedDeploymentId: step.loadedDeploymentId ?? deploymentId,
				reportedDeploymentId: step.loadedDeploymentId ?? deploymentId,
			})),
		});
	}, step.delayMs ?? 0);
}
