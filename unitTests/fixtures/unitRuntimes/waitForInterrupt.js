const fs = require('node:fs');
describe('an interrupted lane', () => {
	it('keeps the real test process alive until interrupted', (done) => {
		fs.writeFileSync(process.env.HARPER_TEST_PROCESS_PID, String(process.pid));
		setInterval(() => {}, 1000);
		void done;
	});
});
