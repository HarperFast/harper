// Plain 200 response: exercises the normal writeHead path.
export class Echo extends Resource {
	get() {
		return { ok: true };
	}
}

// Sets its own X-Frame-Options: configured securityHeaders must NOT override it (app wins).
export class FrameDeny extends Resource {
	get() {
		const headers = new Headers();
		headers.set('X-Frame-Options', 'DENY');
		return { status: 200, headers, data: { framed: 'deny' } };
	}
}

// Throws: exercises the request handler's error (onError) path.
export class Boom extends Resource {
	get() {
		const error = new Error('intentional test error');
		error.statusCode = 500;
		throw error;
	}
}
