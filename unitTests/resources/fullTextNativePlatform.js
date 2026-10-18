async function supportsPublishedFullTextBinding() {
	const glibc = process.platform === 'linux' && process.report?.getReport().header.glibcVersionRuntime;
	if (!(
		(process.platform === 'darwin' && process.arch === 'arm64') ||
		(process.platform === 'linux' && glibc && ['arm64', 'x64'].includes(process.arch)) ||
		(process.platform === 'win32' && process.arch === 'x64')
	))
		return false;
	try {
		await import('@harperfast/fulltext/native');
		return true;
	} catch (error) {
		if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@harperfast/fulltext')) return false;
		throw error;
	}
}

module.exports = { supportsPublishedFullTextBinding };
