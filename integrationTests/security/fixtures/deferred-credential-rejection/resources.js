// PublicNotice is readable by anyone, including an unauthenticated caller. Everything else keeps
// Harper's default authorization.
export class PublicNotice extends tables.PublicNotice {
	allowRead() {
		return true;
	}
}
