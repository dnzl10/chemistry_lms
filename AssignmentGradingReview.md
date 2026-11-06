# SYSTEM AUDIT MISSION: Assignment, Submission, and Grading Architecture Review

### Context & Goal
You are an expert Senior Full-Stack Software Architect, Lead Security Engineer, and QA Auditor. 
Your objective is to conduct a 1000% rigorous, forensic-level architectural review of our Learning Management System (LMS) codebase, schema, and UI implementations specifically within the **Assignment, Submission, and Grading modules**.

You will cross-examine our current implementation against 8 specific enterprise-tier target features listed below. Your task is to identify what currently exists, what is partially implemented, and what is completely missing.

---

### Audit Rules of Engagement (Strict Compliance)
1. **Zero Assumptions / Zero Hallucination:** Never assume a feature exists simply because a route or UI button exists. Verify backend controllers, database schemas, validation layers, worker pipelines, and UI state handlers.
2. **Evidence-Based Reporting:** For every feature evaluated:
   - Cite exact file paths, schema columns, database tables, API routes, or UI components if **[IMPLEMENTED]** or **[PARTIAL]**.
   - If no supporting code or schema exists, strictly flag it as **[NOT IMPLEMENTED / MISSING]**.
3. **Role-Based Access Control (RBAC) Verification:** Review capabilities across three distinct user actors: **Student**, **Teacher**, and **Admin**.
4. **Gap Analysis & Technical Debt:** Point out edge cases, security vulnerabilities, or missing database constraints for each item.

---

### Audit Checklist: 8 Target Features Across 3 Tiers

#### TIER 1: Low Complexity
1. **Grace Period Buffer with Transparency**
   - *Brief Description:* An automated, silent buffer window (e.g., 2–5 minutes) post-official deadline to absorb network latency without blocking the student, while visibly tagging grace-period submissions on the teacher dashboard.
   - *Audited Capabilities:*
     - **Student:** Visible official deadline (buffer kept hidden from UI); unobstructed submission during grace buffer; automated post-submission banner ("Submitted during grace period window").
     - **Teacher:** Clear timestamp visibility with yellow/warning status badge `Submitted during grace period (+X mins)`; manual override/penalty policy support; per-assignment enable/disable/duration toggle.
     - **Admin:** Campus/system-wide default buffer configuration; time-sync and grace window API audit logs.

2. **Cryptographic Submission Receipt (SHA-256 Hash)**
   - *Brief Description:* A tamper-proof digital fingerprint (SHA-256 hash) automatically calculated by the server per submitted file upon receipt, serving as non-repudiation proof of submission.
   - *Audited Capabilities:*
     - **Student:** Instant printable/copyable receipt string (SHA-256, file size, server timestamp) on UI and transactional email; self-verification client-side drag-and-drop hash checker.
     - **Teacher:** Submission details drawer displaying the SHA-256 hash string for dispute defense.
     - **Admin:** Admin-level lookup console to verify student hashes directly against database records; algorithm and hash retention management.

3. **Smart Batch Actions ("Message Students Who...")**
   - *Brief Description:* A high-speed bulk communication and batch-grading filter on the teacher dashboard based on real-time submission states.
   - *Audited Capabilities:*
     - **Student:** Receipt of individualized/BCC targeted reminders (e.g., 24h before deadline) and automated "Missing / 0" notifications.
     - **Teacher:** Multi-condition filtering engine (*Haven't submitted yet*, *Scored below X%*, *Submitted during grace period*); mass-messaging dispatch; one-click bulk "Score: 0" and default feedback attribution.
     - **Admin:** Email/SMS dispatch throttling and rate-limit guardrails; message log auditing for compliance.

---

#### TIER 2: Moderate Complexity
4. **Reusable "Comment Bank" with Keyboard Snippets (Text Expander)**
   - *Brief Description:* A built-in text expander allowing instructors to store reusable feedback phrases activated via slash commands (e.g., `/cite`, `/format`).
   - *Audited Capabilities:*
     - **Student:** Clean, read-only rendered expanded text (raw slash commands never visible).
     - **Teacher:** Full personal CRUD for snippet shortcuts; auto-complete dropdown trigger when typing `/`; import/export between courses/sections.
     - **Admin:** Institution-wide default feedback template repositories; usage frequency analytics for curricular evaluation.

5. **Zero-Footprint Document Sanitizer**
   - *Brief Description:* An automated background privacy pipeline stripping sensitive metadata (EXIF, GPS coordinates, camera models, local OS file paths, author tags) from submitted files prior to persistent storage (GDPR/FERPA).
   - *Audited Capabilities:*
     - **Student:** Transparent, automated scrubbing; visible security badge ("File sanitized and secured").
     - **Teacher:** Safe retrieval and in-browser preview of cleaned documents without software glitches or security risks.
     - **Admin:** Configurable metadata exclusion rules; background worker pipeline monitoring and failure logs.

6. **Pre-submission Smart Diagnostic (Self-Check Checklist)**
   - *Brief Description:* Real-time client/pre-flight verification inspecting files before final upload to catch blank PDFs, mismatched formats, or unmet word count thresholds.
   - *Audited Capabilities:*
     - **Student:** Interactive pre-flight checklist modal (format check, word count target, blank page warning); self-correction before final save.
     - **Teacher:** Per-assignment diagnostic parameter configuration; exemption toggle for unstructured/creative tasks; submission logs indicating ignored warnings.
     - **Admin:** Extraction engine file-size limits and performance caps to safeguard server resources.

---

#### TIER 3: High Complexity
7. **High-Speed "Zero-Click" Grading UI (Hotkeys Navigation)**
   - *Brief Description:* A keyboard-driven Single Page Application (SPA) grading workspace minimizing click fatigue via hotkey-driven navigation, rubric scoring, and record saves.
   - *Audited Capabilities:*
     - **Student:** Indirect beneficiary through rapid turnaround of grades and feedback.
     - **Teacher:** Dedicated keyboard shortcuts (`J`/`K` or `Up`/`Down` for student switching without page reload, `1`-`5` for active rubric scoring, `C` to focus feedback textarea, `Enter` to commit score and advance); shortcut cheat sheet modal (`?`); mouse-mode toggle.
     - **Admin:** Pre-fetching cache feature toggles for low-bandwidth environments; time-per-grade telemetry analytics.

8. **In-Line Split-View with Interactive Rubric & Quick Audio Notes**
   - *Brief Description:* A dual-panel grading interface providing zero-download browser document previews alongside an interactive scoring rubric and native voice-memo recorder.
   - *Audited Capabilities:*
     - **Student:** Unified view of highlighted/annotated document alongside the graded rubric matrix; native inline audio player with playback speed controls (1x, 1.25x, 1.5x).
     - **Teacher:** In-browser annotations (highlighter, pins, freehand drawing); clickable rubric matrix with automatic total score calculations; integrated browser mic recorder (up to 60s voice notes) with waveform preview.
     - **Admin:** Audio file lifecycle and compression policies (`.opus`/`.mp3` transcode, archival to cold storage); server-side document conversion pipeline management (`.docx`/`.pptx` to vector PDF).

---

### Required Output Format

For every single feature (1 through 8), format your evaluation using the following structure:

#### Feature [#]: [Feature Name]
- **Current Status:** `[IMPLEMENTED]` | `[PARTIALLY IMPLEMENTED]` | `[NOT IMPLEMENTED / MISSING]`
- **Technical Evidence Found:**
  - *Database / Schema:* (Identify tables/columns or specify "None")
  - *Backend Services / APIs:* (Identify routes, controllers, services or specify "None")
  - *Frontend / UI Components:* (Identify views, components, event listeners or specify "None")
- **RBAC Audit:**
  - *Student Capability:* (Working, Missing, or Broken)
  - *Teacher Capability:* (Working, Missing, or Broken)
  - *Admin Capability:* (Working, Missing, or Broken)
- **Gaps & Action Items:** (Bullet points detailing what must be created, fixed, or secured to reach full 100% compliance with the target spec)

---

### Executive Scorecard
At the conclusion of the audit, produce:
1. A **Status Matrix Table** showing Feature Name | Status | Complexity Tier | RBAC Completeness %.
2. An **Immediate Roadmap**: Prioritized list of what to build first based on low-hanging architectural wins vs. blocking dependencies.