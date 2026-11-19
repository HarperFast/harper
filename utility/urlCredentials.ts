// A raw `/ ? #` in a password is indistinguishable from a path delimiter, so redact through the last `@` in the
// token. The regex consumes the whole token and the replacer finds the `@`, keeping the scan linear.
const CREDENTIAL_URL_TOKEN_PATTERN = /(?<=[a-z][a-z0-9+.-]*:\/\/)\S+/gi;

export function redactUrlCredentials(text: string): string {
	return text.replace(CREDENTIAL_URL_TOKEN_PATTERN, (token) => {
		const at = token.lastIndexOf('@');
		return at < 0 ? token : `[REDACTED]${token.slice(at)}`;
	});
}
