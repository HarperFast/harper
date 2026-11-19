'use strict';

// Preloaded (--require) into a real restore child. Once authorized it reports a refusal, which settles
// the runner, and only after that says it is about to destroy its target. It records its pid so a test
// can see the runner kill it.
const { writeFileSync } = require('node:fs');

if (process.env.HARPER_RESTORE_CHILD_SPEC && process.send) {
	writeFileSync(process.env.HARPER_LATE_CHILD_PID_FILE, String(process.pid));
	process.on('message', (message) => {
		if (message?.type !== 'authorize') return;
		process.send({ type: 'refused', reason: 'busy' });
		process.send({ type: 'destroying' });
	});
}
