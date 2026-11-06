Act as a Senior Web Application Security Auditor, Data Privacy Compliance Specialist, and Accessibility (WCAG) Expert.

Your task is to conduct a rigorous, comprehensive compliance, legal risk, and privacy audit for my Learning Management System (LMS) web application.

Here is the context of my project:
- System Type: Learning Management System (LMS)
- Primary Users: Students, Instructors, Administrators
- Tech Stack / Architecture: [Specify here: e.g., Node.js/Express, EJS/React, MySQL/MongoDB, etc.]
- Project Files / Codebase attached or provided below: [Attach or paste directory structure, routes, middleware, and key views]

Please analyze my project thoroughly against international and local compliance standards (GDPR, Data Privacy Act of 2012 / RA 10173, COPPA/FERPA principles, and WCAG 2.1 AA). 

Structure your audit report using the following specific sections:

### 1. Mandatory Legal Documents & Form Consent Audit
- Check if Privacy Policy, Terms and Conditions, and Cookie Policy exist and where they are linked (e.g., footer, navigation, registration flows).
- Inspect all data-collection forms (registration, profile editing, quiz submissions, contact forms).
- Identify: Are there explicit, unbundled consent checkboxes before data is submitted? Is consent recorded in the database?

### 2. Cookie Usage & Tracking / Analytics Inspection
- Scan all client-side scripts, dependencies (package.json / CDN links), and cookies set via headers/middleware.
- Determine: Does the system use non-essential cookies (marketing, behavioral analytics, session recorders)?
- Flag whether a Cookie Banner / Consent Management Platform is strictly legally required based on the detected scripts.

### 3. Third-Party Embeds & Supply-Chain Security
- Scan views/templates for external resources: `<iframe>` tags (e.g., YouTube, Vimeo, SlideShare), external CDNs, web fonts, or foreign JavaScript libraries.
- Flag risks regarding third-party tracking on students, referrer leakages, and lack of attributes (e.g., missing `sandbox`, `referrerpolicy="no-referrer"`, or missing Subresource Integrity / SRI hashes).

### 4. Codebase Evidence & Verification Guide
- Point out the exact files, routes, or components where each policy or consent mechanism is currently implemented.
- If missing or incomplete, pinpoint the exact file paths or middleware where I need to insert them (e.g., registration route, footer partial, session config).

### 5. Web Accessibility Audit (WCAG 2.1 Level AA)
- Review UI templates for accessibility compliance:
  - Proper semantic HTML (`<main>`, `<nav>`, `<button>` vs `<a>`).
  - Form labels (`<label for="...">` or `aria-label`).
  - Keyboard navigability and ARIA roles for custom interactive elements.
  - Image alt texts, color contrast risks, and screen-reader friendliness.

### 6. Prioritized Risk Register & Action Plan
- Provide a summary table of all flagged risks categorized by Severity:
  - **CRITICAL / HIGH RISK** (Direct legal exposure, data privacy violation, unauthorized tracking of minors/students, missing core consents).
  - **MEDIUM RISK** (Missing accessibility attributes, insecure third-party embeds, vague policy disclosures).
  - **LOW / BEST PRACTICE** (Documentation enhancements, cookie optimization).
- For each Critical and Medium risk, provide concrete code snippets or actionable remediation steps to resolve them immediately.