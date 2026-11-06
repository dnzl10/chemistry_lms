# MISSION: FORENSIC GAP-ANALYSIS & IMPLEMENTATION DIFF (TEACHER ACCESS LEVEL)

## I. CONTEXT & ARCHITECTURAL GROUNDING
You have previously completed the architectural specification report (**ELEMENTA LMS: FULL-STACK REVERSE-ENGINEERING & DUAL-SIDED PORTAL ARCHITECTURE SPECIFICATION**). 

The **Student Access Level** is 100% complete and operational. A partial or preliminary **Teacher Access Level** exists across:
- Routes & APIs: `routes/teacher.js`
- View Templates: `views/teacher/` and `views/*teacher*.ejs`
- Middleware & Guards: `middleware/auth.js` (and any teacher auth variations)
- Backend Services: `services/`
- Schema Migrations: `migrations/` and `chemistry_arcade_lms (newly and updated without data).sql`

Your objective is to run a ruthless, zero-assumption **Implementation Gap Audit** comparing what was specified in the reverse-engineering report against what **ACTUALLY EXISTS AND WORKS** inside the project files right now.

---

## II. EXECUTION PROTOCOLS & SCRUTINY RULES
1. **Physical Verification Only:** Do not guess. Inspect the files line by line. An endpoint or page is NOT implemented if:
   - The route is missing or simply renders a dummy/stub template (`res.render('coming-soon')` or `res.send('TODO')`).
   - The route is defined but lacks database mutation logic (`db.query(...)` with appropriate `INSERT`/`UPDATE`).
   - The frontend template exists but contains non-functional buttons, placeholder forms, or missing `fetch()` handlers.
   - The backend mutation is missing database transaction blocks (`START TRANSACTION`, `COMMIT`, `ROLLBACK`) where multi-table consistency is mandatory.
2. **End-to-End Tracing:** A feature is only counted as "Implemented" if a user can click it in the UI, hit an existing route, execute valid SQL, update the database, and receive feedback (e.g., flash alert, DOM update, or redirection).

---

## III. REQUIRED AUDIT DELIVERABLES

Execute the following 5 forensic modules and deliver a comprehensive diagnostic breakdown:

---

### MODULE 1: VIEW LAYER & UI COMPLETENESS AUDIT
Inspect all existing teacher views inside `views/teacher/` and root `views/`:
1. **Catalog of Teacher Templates:** List every `.ejs` file dedicated to the teacher role.
2. **Missing Screens:** Identify which core views specified in the baseline do NOT exist yet (e.g., Dedicated Rubric Scoring Workspace, Fast Bulk-Grade Sheet, Annotation/Doubt Triage Dashboard, Section-Specific Topic Pacing View, Whitelist Management View).
3. **Ghost UI Elements:** In existing teacher templates, identify all buttons, dropdowns, tabs, or modals that are visual dummies (no associated JavaScript click listener, unbound `<form action>`, or pointing to a `#` / non-existent route).

---

### MODULE 2: ROUTE & API PARITY MATRIX (SPEC VS. ACTUAL)
Cross-reference the 14 core operational counterparts from **Section V (API Surface Inversion Matrix)** of the architectural spec with `routes/teacher.js`:

| # | Expected Teacher Capability | Expected Endpoint(s) | Actual Status (`Missing` / `Stubbed` / `Implemented`) | File & Line Reference | Missing Logic / Unhandled Errors |
|---|---|---|---|---|---|
| 1 | Announcement Authoring & Priority Toggle | `POST/PUT/DELETE /teacher/api/announcement*` | | | |
| 2 | Read/Reach Metrics Audit | `GET /teacher/api/announcement/:aid/metrics` | | | |
| 3 | Section Whitelist & Enrollment Controls | `POST /teacher/class/:id/whitelist/*` | | | |
| 4 | Section Topic & Quarter Lock Pacing | `PATCH /teacher/api/topic/:tid/lock` | | | |
| 5 | Learning Material Upload & AI Summaries | `POST/PUT/DELETE /teacher/api/material*` | | | |
| 6 | Assessment Authoring from Question Bank | `POST/PUT /teacher/api/assessment*` | | | |
| 7 | Submission Review & Receipt Hash Verify | `GET/POST /teacher/api/grading/*` | | | |
| 8 | Multi-Criteria Rubric Builder & Matrix Evaluation | `POST /teacher/api/rubric*` | | | |
| 9 | Multimodal / Audio Feedback Upload | `POST /teacher/api/grading/audio-feedback` | | | |
| 10 | Anonymous Author Unmasking & Audit Trail | `POST /teacher/api/forum/unmask-author` | | | |
| 11 | Arcade Class Telemetry & Gradebook Sync | `GET/POST /teacher/api/arcade/*` | | | |
| 12 | Class Calendar Publishing & Filtering | `POST/PUT/DELETE /teacher/api/calendar-event*` | | | |
| 13 | Direct 1-on-1 Student Interventions | `GET/POST /teacher/api/messages*` | | | |
| 14 | PDF Student Annotation & Doubt Resolution | `GET /teacher/api/materials/:mid/student-queries` | | | |

---

### MODULE 3: TRANSACTION & DATA-INTEGRITY FORENSICS
Inspect all mutating endpoints in `routes/teacher.js` to identify missing transactions and unsafe data operations:
1. **Missing Atomic Transactions:** Scan operations touching multiple tables (e.g., Deleting an assessment along with its questions/rubrics/scores, or Bulk Grade recording into `student_scores` + `submission_receipts` + `activity_logs`). Flag where `connection.beginTransaction()` is absent.
2. **Unvalidated Mutations:** Flag endpoints that write to the database without checking payload types, null constraints, or allowed ENUM values.
3. **Orphaned State Vulnerabilities:** Detect places where records are deleted without cleaning up foreign child tables (cascades not handled at either the application or DDL level).

---

### MODULE 4: RBAC & IDOR EXPLOIT RUNTIME CHECK
Audit the security posture of every active route in `routes/teacher.js`:
1. **Unprotected Teacher Routes:** Flag any route missing the `isTeacher` / `requireTeacher` middleware.
2. **Active IDOR Vulnerabilities:** 
   - Identify every route taking a parameter (`:classId`, `:id`, `:aid`, `:scoreId`, `:studentId`) where the SQL query fails to verify `classes.teacher_id = req.user.user_id` or check assessment ownership.
3. **File Exposure:** Check how teacher material uploads and student submissions are accessed. Are files served via public static directories without session checks?

---

### MODULE 5: ACTIONABLE IMPLEMENTATION BACKLOG (TRIAGED BY SEVERITY)
Synthesize your findings into a chronological, actionable work backlog:
1. **Blocker (P0):** Critical missing endpoints or broken transactions that prevent the teacher from grading, setting up classes, or cause server crashes.
2. **High Priority (P1):** Unimplemented UI pages and core counterpart features (rubrics, section locking, announcement reach metrics).
3. **Enhancement & Analytics (P2):** Early warning algorithms, arcade telemetric charts, and batch accelerators (mass due-date extenders, quick scorers).

---

## IV. OUTPUT FORMATTING
- Present your findings directly and methodically.
- Reference exact code line numbers (`file.js:Lxx`) for all bugs, missing routes, and stubbed handlers.
- Provide production-ready drop-in code snippets for any missing critical route handlers or middleware.