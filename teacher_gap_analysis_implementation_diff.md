# FORENSIC GAP-ANALYSIS & IMPLEMENTATION DIFF (TEACHER ACCESS LEVEL)
**System:** Elementa Chemistry LMS & Arcade Cabinet Engine  
**Target Repository:** `chemistry_lms_backup - Copy`  
**Standard:** Zero Hallucination, Physical Line-by-Line Code Verification, Strict Anti-IDOR Multi-Tenant Security

---

## I. EXECUTIVE SUMMARY & FORENSIC DISCOVERY

Following the architectural specification established in [`teacher_full_review_student_architecture.md`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/teacher_full_review_student_architecture.md), a physical line-by-line audit of [`routes/teacher.js`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js) (7,153 lines), [`views/teacher/`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/) (15 templates), [`middleware/auth.js`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/middleware/auth.js), and database schemas was conducted.

### Core Discoveries
1. **Extensive Preliminary Logic Exists:** The codebase is NOT empty; [`routes/teacher.js`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js) already implements 7,153 lines containing class rosters, question bank management, grading workspace rendering, anonymous unmasking audit trails, and PDF report generators.
2. **Critical Transaction & Data-Integrity Gaps:** High-impact multi-table operations (assessment deletion, grading saves with group grade propagation) execute sequential SQL queries without atomic database transactions (`START TRANSACTION` / `COMMIT` / `ROLLBACK`). A single failure leaves the gradebook or curriculum in a partially deleted or desynchronized state.
3. **Pervasive IDOR Vulnerabilities:** While `isTeacher` verifies that `req.user.role === 'Teacher'`, key parameterised routes (`:scoreId`, `:aid`, `:classId`, `:mid`, `:eid`) fail to verify if the requesting teacher is actually the assigned instructor of that class or assessment. Any authenticated teacher can overwrite grades or delete assignments across the entire institution.
4. **Curriculum Pacing Collision:** Topic and quarter locking (`PATCH /api/topic/:tid/lock`) mutates global tables (`topics.is_locked`, `quarters.is_locked`). When Teacher A locks a topic for Section Gold, it locks that topic school-wide for all sections taking that subject.
5. **Missing Standalone API Surfaces:** Standalone Rubric CRUD (`POST/PUT/DELETE /teacher/api/rubric*`), manual Arcade Gradebook Re-Sync (`POST /teacher/api/arcade/sync-gradebook`), and batch accelerators (mass due-date extenders) are missing.

---

## II. MODULE 1: VIEW LAYER & UI COMPLETENESS AUDIT

### 1. Catalog of Dedicated Teacher Templates
The following 15 EJS templates in [`views/teacher/`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/) and 2 partials in [`views/teacher/partials/`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/partials/) comprise the Teacher View Layer:

| Template Name | File Path | Lines | Operational Status |
|---|---|---|---|
| `dashboard.ejs` | [`views/teacher/dashboard.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/dashboard.ejs) | 1,143 | **Active:** Key metrics, upcoming tasks, class overview cards, notification drawer. |
| `class_list.ejs` | [`views/teacher/class_list.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class_list.ejs) | 1,164 | **Active:** Grid of assigned classes, add-class modal, section filter. |
| `class-view.ejs` | [`views/teacher/class-view.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class-view.ejs) | 7,946 | **Active (Monolithic):** Class roster, topics/materials/assessments tabs, attendance, settings, whitelist. |
| `question_bank.ejs` | [`views/teacher/question_bank.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/question_bank.ejs) | 1,514 | **Active:** Elementa question bank, filtering by level/machine, question modal. |
| `grading_workspace.ejs` | [`views/teacher/grading_workspace.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/grading_workspace.ejs) | 725 | **Active (SPA):** Split-pane document viewer (PDF.js / Mammoth.js), rubric drawer, keyboard hotkeys (`J`/`K`), audio voice note recorder. |
| `forums.ejs` | [`views/teacher/forums.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/forums.ejs) | 993 | **Active:** Discussion threads, endorsements, reply moderation, anonymous unmask modal. |
| `reports.ejs` | [`views/teacher/reports.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/reports.ejs) | 1,212 | **Active:** PDF/Excel generation (SF9 report card, class list, master grade sheets). |
| `arcade_telemetry.ejs` | [`views/teacher/arcade_telemetry.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/arcade_telemetry.ejs) | 884 | **Active:** Periodic table heatmap, reaction latency curves, session replay timeline. |
| `game_configuration.ejs` | [`views/teacher/game_configuration.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/game_configuration.ejs) | 1,775 | **Active:** Cabinet difficulty threshold tuning, button mapping, kiosk status. |
| `analysis.ejs` | [`views/teacher/analysis.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/analysis.ejs) | 1,029 | **Active:** Bloom's Taxonomy analytics, item discrimination indices ($P$ & $D$). |
| `profile.ejs` | [`views/teacher/profile.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/profile.ejs) | 1,026 | **Active:** Faculty profile, security credentials, department affiliation. |
| `material-queries.ejs` | [`views/teacher/material-queries.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/material-queries.ejs) | 215 | **Active:** PDF annotation questions grouped by material. |
| `material-queries-viewer.ejs`| [`views/teacher/material-queries-viewer.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/material-queries-viewer.ejs)| 262 | **Active:** In-context PDF reader displaying student inline sticky notes. |
| `backupquestionbank.ejs` | [`views/teacher/backupquestionbank.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/backupquestionbank.ejs)| 2,367 | **Orphaned Draft:** Legacy unmaintained duplicate of `question_bank.ejs`. |
| `try.ejs` | [`views/teacher/try.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/try.ejs) | 711 | **Orphaned Draft:** Sandbox testing template; unrouted. |
| `batch_message_modal.ejs` | [`views/teacher/partials/batch_message_modal.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/partials/batch_message_modal.ejs)| 214 | **Partial:** Multi-select student direct message dispatcher modal. |
| `comment_bank_modal.ejs` | [`views/teacher/partials/comment_bank_modal.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/partials/comment_bank_modal.ejs)| 186 | **Partial:** Quick snippet manager for grading feedback. |

---

### 2. Missing Screens & Architectural Views
1. **Dedicated Reusable Rubric Builder Workspace:**
   - *Missing:* A dedicated view (`views/teacher/rubrics.ejs`) allowing teachers to create, clone, and manage reusable multi-criteria evaluation matrices independently of a specific assignment creation flow.
2. **Fast Bulk-Grade Spreadsheet View:**
   - *Missing:* A grid view allowing rapid tabular entry of scores across an entire section (similar to Google Classroom or Canvas SpeedGrader spreadsheet). Teachers must currently grade students one-by-one inside `grading_workspace.ejs`.
3. **Section-Isolated Pacing & Lock Manager:**
   - *Missing:* A dedicated control matrix displaying all topics and quarters as rows, and class sections as columns, allowing teachers to lock/unlock units per section without mutating the global curriculum.

---

### 3. Ghost UI Elements & Dead Controls in Existing Templates
Physical inspection identified the following non-functional elements:

1. **Footer Dead Links (`href="#"`):**
   - Present across almost all views: [`views/teacher/dashboard.ejs:L656-L657`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/dashboard.ejs#L656-L657), [`views/teacher/class_list.ejs:L728-L729`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class_list.ejs#L728-L729), [`views/teacher/reports.ejs:L766-L767`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/reports.ejs#L766-L767), [`views/teacher/class-view.ejs:L3832-L3833`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class-view.ejs#L3832-L3833).
   - Links: `<a href="#">Support Lab</a>` and `<a href="#">Atomic Logs</a>` are hardcoded dead anchors.
2. **Dead Anchor in Assignment Builder:**
   - [`views/teacher/class-view.ejs:L3064`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class-view.ejs#L3064): `<a id="btnFullBuilder" href="#" target="_blank">...</a>` is a hidden dead anchor with no dynamic URL binding.
3. **Template & Exemplar Links in Assignment Edit Modal:**
   - [`views/teacher/class-view.ejs:L3164`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class-view.ejs#L3164) and [`L3175`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class-view.ejs#L3175): `asgnExistingFormatLink` and `asgnExistingSampleLink` default to `href="#"` when rendered, causing a page jump if clicked before JS population.

---

## III. MODULE 2: ROUTE & API PARITY MATRIX (SPEC VS. ACTUAL)

Cross-referencing Section V of the architectural specification against [`routes/teacher.js`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js):

| # | Expected Teacher Capability | Expected Endpoint(s) | Actual Status | File & Line Reference | Missing Logic / Unhandled Errors / Gaps |
|---|---|---|---|---|---|
| **1** | Announcement Authoring & Priority Toggle | `POST/PUT/DELETE /teacher/api/announcement*` | **Implemented** | [`routes/teacher.js:L1831-L1971`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1831-L1971) | Verifies class ownership on create, author on update/delete; dispatches webhooks and in-app notifications. |
| **2** | Read/Reach Metrics Audit | `GET /teacher/api/announcement/:aid/metrics` | **Implemented with IDOR Gap** | [`routes/teacher.js:L1974-L2035`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1974-L2035) | Returns reach %, understood vs clarification count. **IDOR:** Does not verify if `ann.teacher_id === req.user.user_id` or if teacher teaches that class. |
| **3** | Section Whitelist & Enrollment Controls | `POST /teacher/class/:id/whitelist/*`<br>`POST /teacher/class/:id/settings` | **Implemented** | [`routes/teacher.js:L736-L890`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L736-L890) | Uses `verifyClassOwnership()`, handles Excel/CSV parsing, transaction lock on `enrolled_count`. |
| **4** | Section Topic & Quarter Lock Pacing | `PATCH /teacher/api/topic/:tid/lock`<br>`PATCH /teacher/api/quarter/:qid/lock` | **Broken Architecture (Global Mutation)** | [`routes/teacher.js:L918-L947`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L918-L947) | Directly updates `topics.is_locked` and `quarters.is_locked` globally across the whole subject. No `class_id` scoping; zero teacher ownership verification. |
| **5** | Learning Material Upload & AI Summaries | `POST/PUT/DELETE /teacher/api/material*` | **Implemented with IDOR Gap** | [`routes/teacher.js:L1026-L1175`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1026-L1175) | Uploads files, triggers AI background processing, notifies students. **IDOR:** `PUT` and `DELETE` do not verify if teacher teaches the topic's subject. |
| **6** | Assessment Authoring from Question Bank | `POST/PUT /teacher/api/assessment*` | **Implemented with Transaction Gap** | [`routes/teacher.js:L1231-L1338`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1231-L1338) | Supports random & manual question selection. **Gap:** Sequential loop inserts into `elementa_assessment_questions` execute without a transaction. `PUT` has no `teacher_id` check. |
| **7** | Submission Review & Receipt Hash Verify | `GET/POST /teacher/api/grading/*` | **Implemented with IDOR & Audit Gap** | [`routes/teacher.js:L6617-L6859`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6617-L6859) | Headless submissions list with rubric criteria scores and group teammates. **Gaps:** Does not display or verify cryptographic SHA256 receipt token. Zero ownership check on `:scoreId`. |
| **8** | Multi-Criteria Rubric Builder & Matrix Evaluation | `POST /teacher/api/rubric*` | **Missing (Standalone)** | [`routes/teacher.js:L1462`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1462) & [`L1664`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1664) | Rubrics are only created as a side-effect inside `POST /api/assignment`. There is NO standalone Rubric CRUD (`POST/PUT/DELETE /teacher/api/rubric*`) for reusable rubric templates. |
| **9** | Multimodal / Audio Feedback Upload | `POST /teacher/api/grading/:scoreId/audio-note` | **Implemented with MIME Gap** | [`routes/teacher.js:L6684-L6733`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6684-L6733) | Uploads `.wav`/`.mp3` voice note, updates `student_scores`, dispatches notification. **Gap:** Missing fileFilter validation on `uploadAudioNote` (accepts any file extension). IDOR on `:scoreId`. |
| **10** | Anonymous Author Unmasking & Audit Trail | `POST /teacher/api/forum/reply/:replyId/reveal` | **Implemented** | [`routes/teacher.js:L4240-L4263`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L4240-L4263) | Validates forum ownership (`reply.teacher_id === teacherId`), records justification in `forum_unmask_logs`, reveals real identity. |
| **11** | Arcade Class Telemetry & Gradebook Sync | `GET/POST /teacher/api/arcade/*` | **Partially Implemented** | [`routes/teacher.js:L7032-L7150`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L7032-L7150) | `arcade-telemetry` view, session replay API, assign remediation implemented. **Missing:** Manual Gradebook Re-Sync endpoint (`POST /teacher/api/arcade/sync-gradebook`) to force sync duel scores. |
| **12** | Class Calendar Publishing & Filtering | `POST/PUT/DELETE /teacher/api/calendar-event*` | **Implemented with Leakage Gap** | [`routes/teacher.js:L2266-L2358`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L2266-L2358) | Creates, updates, deletes events. **Gap:** Lacks `class_id` foreign key. Notifications sent to all students in subject regardless of section. `PUT`/`DELETE` lack `teacher_id` checks. |
| **13** | Direct 1-on-1 Student Interventions | `GET/POST /teacher/api/messages*` | **Implemented with Isolation Gap** | [`routes/teacher.js:L2388-L2413`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L2388-L2413) | Loads thread with student, inserts private message. **Gap:** Does not verify if student is enrolled in teacher's class. Does not dispatch in-app notification to student. |
| **14** | PDF Student Annotation & Doubt Resolution | `GET /teacher/material-queries`<br>`POST /teacher/api/answer-query` | **Implemented with IDOR Gap** | [`routes/teacher.js:L6495-L6573`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6495-L6573) | Renders query list and viewer, updates annotation with answer, notifies student. **Gap:** `queries-viewer/:classId/:materialId` has no class ownership check. |

---

## IV. MODULE 3: TRANSACTION & DATA-INTEGRITY FORENSICS

### 1. Missing Atomic Transactions in Multi-Table Mutations

#### Bug 1: Unsafe Grade Save with Group Grade Replication
- **File Reference:** [`routes/teacher.js:L6736-L6859`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6736-L6859) (`POST /api/grading/:scoreId/save`)
- **Forensic Trace:**
  1. Updates `student_scores` for the active student.
  2. Executes loop of `INSERT ... ON DUPLICATE KEY UPDATE` into `submission_rubric_scores`.
  3. Queries `group_members` and iterates through all teammates.
  4. For each teammate, queries `student_scores` and executes either `UPDATE` or `INSERT`.
  5. For each teammate, iterates through all rubric scores and inserts into `submission_rubric_scores`.
- **Integrity Defect:** This entire routine runs via individual `db.query(...)` calls on the general pool **without a transaction**. If the database or server drops during peer replication, one student receives a grade while their teammates receive nothing, causing irreversible gradebook desynchronization.

#### Bug 2: Non-Atomic Assessment Cascading Deletion
- **File Reference:** [`routes/teacher.js:L1340-L1349`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1340-L1349) (`DELETE /api/assessment/:aid`)
- **Forensic Trace:**
  ```javascript
  await db.execute(`DELETE sr FROM student_responses sr JOIN student_scores ss ON sr.score_id = ss.score_id WHERE ss.assessment_id = ?`, [req.params.aid]);
  await db.execute(`DELETE FROM student_scores      WHERE assessment_id = ?`, [req.params.aid]);
  await db.execute(`DELETE FROM active_sessions     WHERE assessment_id = ?`, [req.params.aid]);
  await db.execute(`DELETE FROM competitive_matches WHERE assessment_id = ?`, [req.params.aid]);
  await db.execute(`DELETE FROM assessments         WHERE assessment_id = ?`, [req.params.aid]);
  ```
- **Integrity Defect:** 5 individual `DELETE` queries executed sequentially without `beginTransaction()`. If statement 3 or 4 fails, the student's historical responses and grades are deleted, but the assessment remains visible as an orphaned, ungradable record.

#### Bug 3: Non-Atomic Assignment Deletion
- **File Reference:** [`routes/teacher.js:L1720-L1726`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1720-L1726) (`DELETE /api/assignment/:aid`)
- **Integrity Defect:** Sequential execution of:
  ```javascript
  await db.execute(`DELETE FROM assignment_audiences WHERE assessment_id = ?`, [aid]);
  await db.execute(`DELETE FROM submission_receipts WHERE assessment_id = ?`, [aid]);
  await db.execute(`DELETE FROM rubrics WHERE assessment_id = ?`, [aid]);
  await db.execute(`DELETE sr FROM student_responses sr JOIN student_scores ss ON sr.score_id = ss.score_id WHERE ss.assessment_id = ?`, [aid]);
  await db.execute(`DELETE FROM student_scores WHERE assessment_id = ?`, [aid]);
  await db.execute(`DELETE FROM assessments WHERE assessment_id = ?`, [aid]);
  ```
  If `DELETE FROM rubrics` succeeds but `DELETE FROM student_scores` fails (e.g. referencing constraints), the rubric definition is destroyed while the assignment remains.

---

### 2. Unvalidated Mutations & ENUM Vulnerabilities

1. **Audio Note Upload MIME Type Bypass:**
   - [`routes/teacher.js:L6582-L6595`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6582-L6595):
     ```javascript
     const uploadAudioNote = multer({
         storage: audioNoteStorage,
         limits: { fileSize: 5 * 1024 * 1024 }
     });
     ```
     `uploadAudioNote` has **no `fileFilter`**. An attacker with teacher credentials can upload executable binaries (`.exe`, `.sh`), malicious `.html`, or PHP scripts into `material_uploads/audio_notes/`.
2. **Attendance Status ENUM Validation Flaw:**
   - [`routes/teacher.js:L2206`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L2206): Validates status against `['Present', 'Late', 'Absent', 'Excused']`. Good, but `check_in_time` is formatted as a plain string without date range sanity checks.

---

## V. MODULE 4: RBAC & IDOR EXPLOIT RUNTIME CHECK

### 1. Active IDOR Vulnerabilities Identified in `routes/teacher.js`

| Endpoint | Method | Parameter | Vulnerability Mechanism | Severity |
|---|---|---|---|---|
| `/api/grading/:scoreId/save` | `POST` | `:scoreId` | [`routes/teacher.js:L6736`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6736): Updates `student_scores` directly using `scoreId` without joining `assessments` or `classes` to verify if `c.teacher_id === req.user.user_id`. | **CRITICAL** |
| `/api/grading/:scoreId/audio-note` | `POST` | `:scoreId` | [`routes/teacher.js:L6684`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6684): Direct update of `voice_note_path` on `student_scores` without ownership verification. | **CRITICAL** |
| `/api/assessment/:aid` | `PUT` / `DELETE` | `:aid` | [`routes/teacher.js:L1281`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1281) & [`L1340`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1340): Modifies or deletes assessment without checking `assessments.teacher_id = req.user.user_id`. | **CRITICAL** |
| `/api/assignment/:aid` | `PUT` / `DELETE` | `:aid` | [`routes/teacher.js:L1523`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1523) & [`L1688`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1688): Modifies or deletes assignments across any subject/teacher. | **CRITICAL** |
| `/api/topic/:tid/lock` | `PATCH` | `:tid` | [`routes/teacher.js:L930`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L930): Updates global `topics.is_locked` without verifying if teacher teaches the topic. | **HIGH** |
| `/api/material/:mid` | `PUT` / `DELETE` | `:mid` | [`routes/teacher.js:L1104`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1104) & [`L1150`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1150): Directly updates/deletes `learning_materials` without subject ownership check. | **HIGH** |
| `/api/announcement/:aid/metrics`| `GET` | `:aid` | [`routes/teacher.js:L1974`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1974): Queries student acknowledgment details for any announcement ID. | **MEDIUM** |
| `/api/live-sessions/:classId` | `GET` | `:classId` | [`routes/teacher.js:L2094`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L2094): Allows observing live exam progress of any class section. | **MEDIUM** |
| `/queries-viewer/:classId/:mid` | `GET` | `:classId` | [`routes/teacher.js:L6550`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6550): Displays student questions and annotations for any class ID. | **MEDIUM** |
| `/api/calendar-event/:eid` | `PUT` / `DELETE` | `:eid` | [`routes/teacher.js:L2335`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L2335) & [`L2352`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L2352): Updates/deletes `calendar_events` without `teacher_id` check. | **MEDIUM** |

---

### 2. Static File Direct Exposure Audit
- **Upload Directory Locations:**
  - `public/assignment_templates/` and `public/assignment_samples/`: Served statically via `app.use(express.static('public'))` in [`app.js:L123`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/app.js#L123). Exemplar answers and templates are publicly indexable if filenames are discovered.
  - `material_uploads/`: Protected via [`routes/materials.js:L9`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/materials.js#L9) with `ensureAuthenticated` and path traversal checks.
  - `material_uploads/audio_notes/`: Served through `material_uploads/` route with authentication.

---

## VI. MODULE 5: ACTIONABLE IMPLEMENTATION BACKLOG (TRIAGED BY SEVERITY)

### 1. Blocker (P0) — Immediate Security & Integrity Fixes

#### P0-1: Wrap Grading Save & Group Grade Propagation in Atomic Transaction
- **Location:** [`routes/teacher.js:L6736`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6736)
- **Remediation Code Snippet:**
```javascript
// Drop-in replacement for POST /teacher/api/grading/:scoreId/save
router.post('/api/grading/:scoreId/save', isTeacher, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const scoreId = req.params.scoreId;
        const { score, feedback, rubric_scores } = req.body;
        const teacherId = req.user.user_id;

        await conn.beginTransaction();

        // 1. Verify Ownership & Fetch Assessment Info
        const [[scoreRow]] = await conn.query(`
            SELECT ss.score_id, ss.student_id, ss.assessment_id, ss.group_id, ss.total_items,
                   a.teacher_id AS asmt_teacher_id, a.assessment_name, a.is_group_assignment, 
                   a.group_grading_mode, q.subject_id, c.teacher_id AS class_teacher_id
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON q.subject_id = c.subject_id
            WHERE ss.score_id = ?
            FOR UPDATE
        `, [scoreId]);

        if (!scoreRow) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Submission not found' });
        }

        // Anti-IDOR Check: Must be authoring teacher or section teacher
        if (scoreRow.asmt_teacher_id !== teacherId && scoreRow.class_teacher_id !== teacherId && req.user.role !== 'Admin') {
            await conn.rollback();
            return res.status(403).json({ success: false, error: 'Unauthorized: You do not have permission to grade this submission.' });
        }

        const finalScore = score !== undefined && score !== null ? Number(score) : 0;

        // 2. Update Student Score
        await conn.query(`
            UPDATE student_scores 
            SET score_obtained = ?, feedback = ?, date_recorded = NOW()
            WHERE score_id = ?
        `, [finalScore, feedback || '', scoreId]);

        // 3. Upsert Rubric Scores
        if (rubric_scores && Array.isArray(rubric_scores)) {
            for (const r of rubric_scores) {
                if (r.criterion_id) {
                    await conn.query(`
                        INSERT INTO submission_rubric_scores (score_id, criterion_id, points_awarded, criterion_feedback)
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE points_awarded = VALUES(points_awarded), criterion_feedback = VALUES(criterion_feedback)
                    `, [scoreId, r.criterion_id, Number(r.points_awarded) || 0, r.criterion_feedback || '']);
                }
            }
        }

        // 4. Group Grade Propagation (Atomic)
        if (scoreRow.is_group_assignment && scoreRow.group_grading_mode === 'shared_grade' && scoreRow.group_id) {
            const [members] = await conn.query(
                `SELECT student_id FROM group_members WHERE group_id = ?`,
                [scoreRow.group_id]
            );

            for (const m of members) {
                if (m.student_id !== scoreRow.student_id) {
                    const [[existingPeer]] = await conn.query(
                        `SELECT score_id FROM student_scores WHERE student_id = ? AND assessment_id = ? LIMIT 1 FOR UPDATE`,
                        [m.student_id, scoreRow.assessment_id]
                    );

                    let peerScoreId;
                    if (existingPeer) {
                        peerScoreId = existingPeer.score_id;
                        await conn.query(
                            `UPDATE student_scores SET score_obtained = ?, feedback = ?, date_recorded = NOW(), group_id = ? WHERE score_id = ?`,
                            [finalScore, feedback || '', scoreRow.group_id, peerScoreId]
                        );
                    } else {
                        const [insPeer] = await conn.query(
                            `INSERT INTO student_scores (student_id, assessment_id, score_obtained, total_items, total_possible_score, feedback, date_recorded, group_id)
                             VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
                            [m.student_id, scoreRow.assessment_id, finalScore, scoreRow.total_items || 100, scoreRow.total_items || 100, feedback || '', scoreRow.group_id]
                        );
                        peerScoreId = insPeer.insertId;
                    }

                    if (rubric_scores && Array.isArray(rubric_scores)) {
                        for (const r of rubric_scores) {
                            if (r.criterion_id) {
                                await conn.query(`
                                    INSERT INTO submission_rubric_scores (score_id, criterion_id, points_awarded, criterion_feedback)
                                    VALUES (?, ?, ?, ?)
                                    ON DUPLICATE KEY UPDATE points_awarded = VALUES(points_awarded), criterion_feedback = VALUES(criterion_feedback)
                                `, [peerScoreId, r.criterion_id, Number(r.points_awarded) || 0, r.criterion_feedback || '']);
                            }
                        }
                    }
                }
            }
        }

        await conn.commit();
        res.json({ success: true, message: 'Grade and rubric evaluation saved atomically.' });

    } catch (err) {
        await conn.rollback();
        console.error('[POST /teacher/api/grading/:scoreId/save Error]', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        conn.release();
    }
});
```

#### P0-2: Implement Standalone Reusable Rubric Endpoints
- **Endpoints to Add to [`routes/teacher.js`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js):**
```javascript
// POST /teacher/api/rubric — Create Standalone or Assessment Rubric
router.post('/api/rubric', isTeacher, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { assessment_id, title, criteria } = req.body;
        if (!title || !title.trim()) throw new Error('Rubric title is required');

        await conn.beginTransaction();

        const [rRes] = await conn.execute(
            `INSERT INTO rubrics (assessment_id, title) VALUES (?, ?)`,
            [assessment_id || null, title.trim()]
        );
        const rubricId = rRes.insertId;

        if (Array.isArray(criteria) && criteria.length > 0) {
            for (let i = 0; i < criteria.length; i++) {
                const c = criteria[i];
                await conn.execute(
                    `INSERT INTO rubric_criteria (rubric_id, criterion_name, criterion_description, max_points, sort_order)
                     VALUES (?, ?, ?, ?, ?)`,
                    [rubricId, c.criterion_name.trim(), c.criterion_description || '', Number(c.max_points) || 10, i + 1]
                );
            }
        }

        await conn.commit();
        res.json({ success: true, rubric_id: rubricId });
    } catch (e) {
        await conn.rollback();
        res.status(500).json({ success: false, error: e.message });
    } finally {
        conn.release();
    }
});

// GET /teacher/api/rubric/:id — Fetch Rubric Definition & Criteria
router.get('/api/rubric/:id', isTeacher, async (req, res) => {
    try {
        const [[rubric]] = await db.query(`SELECT * FROM rubrics WHERE rubric_id = ?`, [req.params.id]);
        if (!rubric) return res.status(404).json({ success: false, error: 'Rubric not found' });

        const [criteria] = await db.query(
            `SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC`,
            [req.params.id]
        );
        rubric.criteria = criteria;

        res.json({ success: true, rubric });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
```

#### P0-3: Secure Voice Note Upload with MIME Validation
- **Location:** [`routes/teacher.js:L6582`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L6582)
```javascript
const uploadAudioNote = multer({
    storage: audioNoteStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /audio\/(webm|wav|mpeg|ogg|mp4|aac|m4a)/;
        const ext = path.extname(file.originalname).toLowerCase();
        const allowedExts = ['.webm', '.wav', '.mp3', '.ogg', '.m4a'];
        if (allowedTypes.test(file.mimetype) || allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid audio file type. Only audio recordings are permitted.'));
        }
    }
});
```

---

### 2. High Priority (P1) — Multi-Tenant Section Isolation & Anti-IDOR

#### P1-1: Section-Scoped Topic Pacing (`class_topic_locks`)
Replace the global update in [`routes/teacher.js:L930`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L930) with section-scoped locks:
```javascript
router.patch('/api/class/:classId/topic/:tid/lock', isTeacher, async (req, res) => {
    try {
        const { classId, tid } = req.params;
        const { is_locked } = req.body;
        const teacherId = req.user.user_id;

        // Verify teacher owns class
        const [[cls]] = await db.query(`SELECT class_id FROM classes WHERE class_id = ? AND teacher_id = ?`, [classId, teacherId]);
        if (!cls) return res.status(403).json({ error: 'Unauthorized class access' });

        await db.query(`
            INSERT INTO class_topic_locks (class_id, topic_id, is_locked)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE is_locked = VALUES(is_locked), updated_at = NOW()
        `, [classId, tid, is_locked ? 1 : 0]);

        res.json({ success: true, class_id: classId, topic_id: tid, is_locked });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
```

#### P1-2: Anti-IDOR Middleware Mounting
Mount [`middleware/teacherAuth.js`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/middleware/) across routes taking `:aid`, `:classId`, `:mid`:
- Mount `verifyClassOwnership` on:
  - `GET /api/live-sessions/:classId`
  - `GET /queries-viewer/:classId/:materialId`
  - `GET /api/attendance/:classId`
- Mount `verifyAssessmentOwnership` on:
  - `GET /api/breakdown/:assessmentId`
  - `PUT /api/assessment/:aid`
  - `DELETE /api/assessment/:aid`
  - `PUT /api/assignment/:aid`
  - `DELETE /api/assignment/:aid`

---

### 3. Enhancement & Analytics (P2) — Accelerators & Dashboards

1. **Mass Due-Date Extender Endpoint:**
   `POST /teacher/api/assessments/mass-extend` to allow extending deadlines across selected assessments for an entire section simultaneously.
2. **Arcade Gradebook Manual Sync Endpoint:**
   `POST /teacher/api/arcade/sync-gradebook/:classId` to invoke `arcadeGradeSyncService` for all historical un-synced sessions.
3. **Dead Link Purge:**
   Remove `<a href="#">Support Lab</a>` and `<a href="#">Atomic Logs</a>` from [`views/teacher/dashboard.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/dashboard.ejs), [`views/teacher/class_list.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/class_list.ejs), and [`views/teacher/reports.ejs`](file:///c:/Users/althe/Downloads/LMS%20and%20GAME/chemistry_lms_backup%20-%20Copy/views/teacher/reports.ejs).

---

## VII. AUDIT SIGN-OFF

The implementation gap audit confirms that while Elementa's Teacher Portal possesses sophisticated UI foundations and specialized workflows, securing transactional boundaries, eliminating IDOR vulnerabilities, and isolating section topic pacing are the immediate mandatory steps to achieve 100% production readiness.
