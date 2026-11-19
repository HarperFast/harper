export function getDomainSocketPathMaxBytes(platform = process.platform) {
	return platform === 'darwin' ? 103 : 107;
}

export function isDomainSocketPathTooLong(socketPath: string, platform = process.platform) {
	return Buffer.byteLength(socketPath) > getDomainSocketPathMaxBytes(platform);
}
