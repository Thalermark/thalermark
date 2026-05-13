# Security Policy

Thanks for taking the time to help keep Thalermark and its users safe. We treat security reports seriously and want to make it easy for researchers and users to share what they find.

---

## Reporting a vulnerability

**Preferred channel — GitHub Private Vulnerability Reporting:**
Open a private report at [github.com/Thalermark/thalermark/security/advisories/new](https://github.com/Thalermark/thalermark/security/advisories/new). This keeps the conversation private, lets us collaborate on a fix, and assigns a CVE if appropriate.

**Email backup:** `security@thalermark.com`

**Please do not:**
- Open a public GitHub issue, pull request, or discussion describing the vulnerability
- Post details on social media, blogs, or other public forums before coordinated disclosure
- Test against production systems other than your own self-hosted instance, our public preview, or our sandbox

### What to include

The more we have up front, the faster we can fix:

- Affected component (web, mobile, api, package name, etc.) and version or commit
- A clear description of the vulnerability and its impact
- Reproduction steps — minimal reproduction is ideal
- Proof-of-concept code, payloads, or screenshots if applicable
- Suggested mitigation if you have one
- Your name and contact info if you'd like credit

---

## Our commitment

Thalermark is currently maintained by a small team (often a single person). Our SLAs reflect honest pre-MVP capacity, not aspirational corporate-speak:

| Stage | Target |
|---|---|
| Acknowledge receipt | Within **1 week** of report |
| Severity assessment + triage decision | Within **30 days** (best effort) |
| Coordinated public disclosure | **90 days** from report, extendable by mutual agreement, or earlier if a fix has shipped |

If the report is critical (RCE, auth bypass, mass data exposure), we will treat it accordingly and move faster. We'll keep you informed throughout.

---

## Scope

### In scope

Any vulnerability that materially affects the security or privacy of Thalermark users or their data, including but not limited to:

- Authentication or authorization bypass
- Cross-tenant data leakage (RLS bypass, account/company isolation failure)
- Injection vulnerabilities (SQL, command, template, etc.)
- Server-side request forgery, server-side template injection
- Sensitive data exposure (PII, financial data, credentials, tokens)
- Cryptographic flaws in our own code
- Significant CSRF, XSS, or clickjacking issues
- Privilege escalation between user roles
- Logic flaws in invoicing, payment, or audit code that allow unauthorized actions
- Supply-chain attacks via our own published packages

### Out of scope

To keep the signal-to-noise ratio useful, the following are typically out of scope:

- Denial-of-service attacks (volumetric, ReDoS, etc.) unless they reveal a logic bug
- Social engineering of Thalermark staff or users
- Vulnerabilities in third-party dependencies — please report those upstream; we monitor via Dependabot and address as they're disclosed
- Issues requiring physical access to a user's device
- Self-XSS or attacks requiring an already-compromised user account
- Missing security headers without a concrete attack scenario
- Missing rate limits on non-sensitive endpoints
- Reports from automated scanners without manual verification
- Best-practice suggestions without a demonstrated security impact
- Vulnerabilities in software, infrastructure, or services we don't operate (your own self-hosted deployment's reverse proxy, OS, etc.)

If you're unsure whether something is in scope, send it anyway. We'd rather see a report we can decline than miss something real.

---

## Supported versions

| Version | Supported |
|---|---|
| v0.x (pre-release) | ✅ |

Thalermark is pre-MVP. Once we ship v1.0, we'll publish a formal support window for stable releases.

---

## Safe harbor

We pledge that we will not pursue legal action against researchers who:

- Make a good-faith effort to comply with this policy
- Avoid privacy violations, destruction of data, and degradation of services for other users
- Limit research to their own self-hosted instances or, where they exist, our sandbox / preview environments
- Give us a reasonable opportunity to fix the issue before public disclosure
- Report the issue promptly upon discovery

This safe harbor extends only to the activities outlined above and does not authorize unauthorized access to user data, lateral movement, or persistent access to our systems.

If you are uncertain whether your planned research falls within this policy, contact us at `security@thalermark.com` before proceeding.

---

## Hall of Fame

Security researchers who have responsibly disclosed vulnerabilities to Thalermark are credited here, with their permission.

_No one yet — be the first._

---

## Contact

For anything covered by this policy: open a private report at [github.com/Thalermark/thalermark/security/advisories/new](https://github.com/Thalermark/thalermark/security/advisories/new) or email `security@thalermark.com`.

For general (non-security) inquiries: `hello@thalermark.com`.
