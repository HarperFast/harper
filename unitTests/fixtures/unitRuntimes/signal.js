describe('signal fixture', () => {
	it('terminates', () => process.kill(process.pid, 'SIGTERM'));
});
