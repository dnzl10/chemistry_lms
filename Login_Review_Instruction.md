Act as a Principal Application Security Architect, Lead Penetration Tester, and Senior Backend Auditor specializing in OWASP ASVS (Level 2/3) and NIST SP 800-63B standards.

I need a rigorous, line-by-line security review and Gap Analysis of the current login and session management implementation of my Learning Management System (LMS).

Evaluate my submitted source code, routes, middleware, and database schema strictly against this 13-Point Hardened Security Baseline:

--- MANDATORY BASELINE CHECKLIST ---
1. Automatic Logout (Session Inactivity Timeout): Enforces 15–30 minutes inactivity timeout.
2. Absolute Session Expiration (Max Lifetime): Enforces a hard cap (8–12 hours) regardless of continuous activity.
3. Single Active Session / Concurrent Login Restriction: Prevents multiple concurrent active devices; triggers a remote session revocation / reset prompt if a new login attempt occurs.
4. Session Fixation Defense: Generates a completely new Session ID / Token upon successful credential validation before state binding.
5. Brute-Force & Rate Limiting Defense: Multi-layered rate throttling (IP + Account level, e.g., 5 failed attempts per window) with lockout / delay mechanics.
6. Secure Credential Hashing & Storage: Uses Argon2id or bcrypt (cost factor >= 12) with unique cryptographic salting.
7. Timing-Attack Resilient Verification: Employs constant-time equality checks for hashes/tokens to prevent side-channel timing leaks.
8. Generic Error Messaging: Strictly prevents User Enumeration via consistent error responses (e.g., "Invalid email/username or password").
9. Secure Session/Token Management: Enforces HttpOnly, Secure, and SameSite (Strict/Lax) cookie attributes; implements reliable server-side revocation / blacklist for instant session termination.
10. Server-Side RBAC Validation: Validates user roles (Admin, Teacher, Student) strictly on the server-side before access/redirection.
11. Comprehensive Audit Logging: Records timestamp, User ID, IP address, User-Agent, and authentication outcome (Success, Failure, Force-Reset).
12. Parameterized Queries & Input Sanitization: Uses prepared statements/ORM parameterization to eliminate SQL/NoSQL injection vulnerabilities.
13. Account State & Lifecycle Checks: Evaluates account status (is_active, is_verified, is_suspended) prior to establishing the session.

--- INSTRUCTIONS FOR YOUR REVIEW ---
Perform the review using the following structured format:

### 1. COMPLIANCE SCORECARD & GAP ANALYSIS MATRIX
Present a Markdown Table with the columns:
- Baseline Criterion (1 to 13)
- Current Status: [ IMPLEMENTED | PARTIALLY IMPLEMENTED | MISSING / VULNERABLE ]
- Technical Finding: Concrete reason based on the submitted code.

### 2. DETAILED VULNERABILITY & LOGICAL FLAW BREAKDOWN
For every item marked as PARTIALLY IMPLEMENTED or MISSING:
- Explain the exact architectural weakness or code-level flaw.
- Detail the real-world attack vector (e.g., Session Hijacking, Race Conditions during concurrent logins, Timing Attacks).

### 3. PRODUCTION-READY REMEDIATION CODE
Provide fully refactored, hardened, and clean production code (including middleware, controller logic, and updated database schema) that resolves all identified gaps and achieves 100% compliance with the 13-point baseline.