# Security Policy

## Reporting a Vulnerability

We take security vulnerabilities seriously and appreciate your efforts to responsibly disclose your findings.

If you discover a security vulnerability, please email us at **security@harperdb.io** with the following information:

- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (if available)

We will acknowledge receipt of your report and work with you to understand and resolve the issue promptly.

**Please do not publicly disclose the vulnerability until we have had a chance to address it.**

Thank you for helping keep Harper and our community safe.

## Known Findings

The issues below are already known to us and have been remediated. Please do not
report them; reports referencing them will be closed as duplicates.

### SonarCloud analysis token in `sonar-project.properties`

A SonarCloud analysis token was committed to `sonar-project.properties` in
November 2019 (`aec2a14c`) and removed in June 2025 (`a6e73673`). The token is
not present in any current branch, but it remains reachable in this
repository's published commit history, so automated secret scanners continue to
surface it.

**This token was revoked on TODO-REVOCATION-DATE and is no longer valid.**

We have deliberately chosen not to rewrite this repository's history to remove
it. The credential is already revoked, so a rewrite would provide no additional
security benefit, while invalidating every commit SHA, tag, and release
reference across this project and its forks.
