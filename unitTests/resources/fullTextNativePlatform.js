async function supportsPublishedFullTextBinding() {
	const glibc = process.platform === 'linux' && process.report?.getReport().header.glibcVersionRuntime;
	if (!(
		(process.platform === 'darwin' && process.arch === 'arm64') ||
		(process.platform === 'linux' && glibc && ['arm64', 'x64'].includes(process.arch)) ||
		(process.platform === 'win32' && process.arch === 'x64')
	))
		return false;
	await import('@harperfast/fulltext/native');
	return true;
}

module.exports = { supportsPublishedFullTextBinding };
