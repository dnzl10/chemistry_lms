# Executive Audit Report: Principal Systems Architect & Admin Subsystem Auditor

**Target System:** Chemistry Arcade LMS & ESP32 Kiosk Ecosystem  
**Audit Scope:** Complete Admin Surface Area (`routes/admin.js`, `app.js`, and all `views/admin/*.ejs` templates)  
**Audit Standard:** Zero-Assumption, Concrete Traceability (Routes, Line Numbers, SQL Queries, UI Elements, Downstream Integrity)  
**Audit Timestamp:** October 12, 2026

---

## 1. Executive Summary & Architectural Overview

The Admin subsystem in the Chemistry Arcade LMS comprises **127 mounted routes** across [`routes/admin.js`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js) and [`app.js`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js), supported by **8 dedicated Admin views** in [`views/admin/`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/) and **1 standalone prototype view** ([`views/admin-invite.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin-invite.ejs)).

### Key Findings & Architectural Verdict:
1. **Critical Public Security Leak ([`app.js:180-264`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js#L180-L264)):**  
   The legacy routes `GET /admin-invite` and `POST /admin/invite` are defined on the root Express instance without `ensureAuthenticated` or `requireAdmin`. Any anonymous user on the network can access the invite form, provision users into the database, and trigger emails. Furthermore, this endpoint generates an `inviteToken` that is **never stored** in `account_invitations`, resulting in a broken registration loop for recipients.
2. **5 Broken Navigation Links ("Ghost 404s") on Main Dashboard ([`dashboard.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs)):**  
   The primary dashboard contains 5 prominent cards/buttons linking to non-existent admin routes (`/admin/school-years`, `/admin/calendar`, `/admin/performance`, `/admin/activity-logs`, `/admin/arcade`), returning 404 errors during user interaction.
3. **Dead / Ghost Elements in Academic Management ([`academic_management.ejs:610-637`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L610-L637)):**  
   The "Hardware Button Mapping" and "Competitive Matches" panels in `academic_management.ejs` are non-functional placeholders. The button mapping form triggers `submitAddMapping(event)`, a function that does not exist in client scripts (`ReferenceError`), while active hardware mapping actually resides in `gaming_qbank.ejs`.
4. **Dropped Table References in Cascade Deletions:**  
   Following the SSOT migration in [`01_purge_dead_tables.sql`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/scripts/01_purge_dead_tables.sql), tables such as `student_responses`, `active_sessions`, `competitive_matches`, `leaderboard_history`, `answer_sequences`, and `question_bank` were dropped. Eleven deletion handlers in `admin.js` still issue direct SQL queries against these tables. While wrapped in `try/catch` fallbacks, they represent architectural dead code that pollutes the codebase.
5. **Report Test Paper Generator Options Blanking ([`routes/admin.js:8656-8697`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8656-L8697)):**  
   `GET /admin/rm/test-paper` queries `elementa_questions` for "Standard" (Multiple Choice) questions, but hardcodes `'' AS option_a, '' AS option_b, ...` because `elementa_questions` stores options inside `steps_json` for Godot. This produces test papers with blank answer options (`A. —  B. —  C. —  D. —`).

---

## 2. Complete Admin Route & API Trace

Every route mounted under `/admin` in [`routes/admin.js`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js) and related entry points in [`app.js`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js) has been audited below by subsystem module:

```
[RBAC Guard Architecture]
routes/admin.js:
├── router.use(ensureAuthenticated)  (line 4)   → Checks req.isAuthenticated(), suspension, active session
└── requireAdmin middleware          (line 29)  → Validates req.user.role === 'Admin', redirects to /login
```

### Module A: Core Dashboard & Notifications
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/dashboard` | `GET` | [`admin.js:125`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L125) | `requireAdmin` | None | `SELECT` counts from `users`, `classes`, `assessments`, `activity_logs`, `student_scores`, `elementa_game_sessions` | Renders `admin/dashboard` | **FULLY IMPLEMENTED** |
| `/notifications` | `GET` | [`admin.js:246`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L246) | `requireAdmin` | None | `SELECT` from `notifications` joined with `users` | JSON `{ success, notifications, unreadCount }` | **FULLY IMPLEMENTED** |

---

### Module B: User Access Control (UAC) & Identity Provisioning
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/user_access_control` | `GET` | [`admin.js:392`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L392) | `requireAdmin` | Query filters | `SELECT` from `users`, `account_invitations`, `classes`, `subjects` | Renders `admin/user_access_control` | **FULLY IMPLEMENTED** |
| `/users/:id/toggle-status` | `POST` | [`admin.js:566`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L566) | `requireAdmin` | Body: `{ status: 'active'\|'suspended'\|'archived' }` | `UPDATE users SET is_active=?, is_suspended=?`, clears `current_session_id`, inserts `activity_logs` | JSON `{ success, message }` | **FULLY IMPLEMENTED** |
| `/uac/check-dup` | `GET` | [`admin.js:623`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L623) | `requireAdmin` | Query: `type`, `value`, `exclude_id` | `SELECT` from `users`, `account_invitations` | JSON `{ exists, message }` | **FULLY IMPLEMENTED** |
| `/uac/invite` | `POST` | [`admin.js:679`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L679) | `requireAdmin` | Body: Profile fields, LRN, classId, teacher assignments | `INSERT INTO account_invitations (prefill_data, token)`, triggers `nodemailer` | JSON `{ success, token }` | **FULLY IMPLEMENTED** |
| `/uac/invitations` | `POST` | [`admin.js:992`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L992) | `requireAdmin` | Body: `{ email, role, expiryHours }` | `INSERT INTO account_invitations`, triggers `nodemailer` | JSON `{ success, token }` | **FULLY IMPLEMENTED** |
| `/uac/invitations/clean-expired` | `DELETE` | [`admin.js:1088`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1088) | `requireAdmin` | None | `DELETE FROM account_invitations WHERE expires_at < NOW()` | JSON `{ success, deletedCount }` | **FULLY IMPLEMENTED** |
| `/uac/invitations/:id` | `DELETE` | [`admin.js:1111`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1111) | `requireAdmin` | Param: `id` | `DELETE FROM account_invitations WHERE invitation_id = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/uac/users/:id` | `POST` | [`admin.js:1148`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1148) | `requireAdmin`, `uploadProfile` | Multipart: Profile details | `UPDATE users`, syncs `class_students` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/uac/users/:id` | `DELETE` | [`admin.js:1288`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1288) | `requireAdmin` | Param: `id` | `DELETE FROM users`, unlinks classes, deletes from dropped tables (`student_responses`, etc. inside try/catch) | JSON `{ success }` | **PARTIALLY IMPLEMENTED** (Dead table queries) |
| `/uac/users/:id/reset-password` | `POST` | [`admin.js:1401`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1401) | `requireAdmin` | Param: `id` | Inserts `__RESET__` token into `account_invitations`, sends email | JSON `{ success, resetLink }` | **FULLY IMPLEMENTED** |
| `/uac/users/:id/reset-qr` | `POST` | [`admin.js:1494`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1494) | `requireAdmin` | Param: `id` | `UPDATE users SET qr_code_token = ?` | JSON `{ success, qrToken }` | **FULLY IMPLEMENTED** |
| `/uac/users/:id/unlink-google` | `POST` | [`admin.js:1538`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1538) | `requireAdmin` | Param: `id` | `UPDATE users SET google_id = NULL` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/uac/users/:id/unflag` | `POST` | [`admin.js:1573`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1573) | `requireAdmin` | Param: `id` | `UPDATE users SET is_flagged = 0, flag_reason = NULL` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/uac/bulk-import` | `POST` | [`admin.js:1614`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1614) | `requireAdmin`, `uploadBulk` | Multipart: `.xlsx`/`.xls` | Validates rows, inserts `account_invitations`, auto-sends invitations | JSON `{ success, summary, results }` | **FULLY IMPLEMENTED** |
| `/uac/bulk-template` | `GET` | [`admin.js:2271`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2271) | `requireAdmin` | Query: `type=student\|teacher` | Dynamically builds Excel worksheet with data validation rules | Binary Download `.xlsx` | **FULLY IMPLEMENTED** |
| `/admin-invite` | `GET` | [`app.js:180`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js#L180) | **NONE (Public)** | None | None | Renders `admin-invite.ejs` | **BROKEN / SECURITY RISK** |
| `/admin/invite` | `POST` | [`app.js:187`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js#L187) | **NONE (Public)** | Form body | Direct `INSERT INTO users` without password; drops `inviteToken` | Plain HTML Response | **BROKEN / SECURITY RISK** |

---

### Module C: Academic Management (Curriculum, SY, Classes, Whitelists)
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/academic_management` | `GET` | [`admin.js:2403`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2403) | `requireAdmin` | None | `SELECT` from `school_years`, `subjects`, `quarters`, `topics`, `classes`, `users` | Renders `admin/academic_management` | **FULLY IMPLEMENTED** |
| `/am/school-years` | `POST` | [`admin.js:2489`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2489) | `requireAdmin` | Body: `{ sy_range }` | `INSERT INTO school_years (sy_range)` | JSON `{ success, sy_id }` | **FULLY IMPLEMENTED** |
| `/am/school-years/:id` | `POST` | [`admin.js:2544`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2544) | `requireAdmin` | Body: `{ sy_range }` | `UPDATE school_years SET sy_range = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/school-years/:id/activate` | `POST` | [`admin.js:2590`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2590) | `requireAdmin` | Param: `id` | `UPDATE school_years SET is_active = 0`, then `is_active = 1` for target | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/school-years/:id` | `DELETE` | [`admin.js:2620`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2620) | `requireAdmin` | Param: `id` | `DELETE FROM school_years WHERE sy_id = ?` (guarded against active SY) | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/subjects` | `POST` | [`admin.js:2661`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2661) | `requireAdmin` | Body: `{ subject_name, subject_code, description }` | `INSERT INTO subjects` | JSON `{ success, subject_id }` | **FULLY IMPLEMENTED** |
| `/am/subjects/:id` | `POST` | [`admin.js:2711`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2711) | `requireAdmin` | Body: `{ subject_name, subject_code, description }` | `UPDATE subjects SET ...` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/subjects/:id` | `DELETE` | [`admin.js:2762`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2762) | `requireAdmin` | Param: `id` | Deletes subject, quarters, topics; unlinks/deletes assessments; touches dropped tables inside try/catch | JSON `{ success }` | **PARTIALLY IMPLEMENTED** (Dead queries) |
| `/am/subjects/:id/quarters` | `GET` | [`admin.js:2893`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2893) | `requireAdmin` | Param: `id` | `SELECT` from `quarters` joined with `topics` | JSON `{ success, quarters }` | **FULLY IMPLEMENTED** |
| `/am/subjects/:id/quarters` | `POST` | [`admin.js:2931`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2931) | `requireAdmin` | Body: `{ quarter_number, title }` | `INSERT INTO quarters` | JSON `{ success, quarter_id }` | **FULLY IMPLEMENTED** |
| `/am/quarters/:id/toggle-lock` | `POST` | [`admin.js:3005`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3005) | `requireAdmin` | Body: `{ is_locked }` | `UPDATE quarters SET is_locked = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/quarters/:id` | `DELETE` | [`admin.js:3035`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3035) | `requireAdmin` | Param: `id` | Deletes quarter, topics, unlinks questions | JSON `{ success }` | **PARTIALLY IMPLEMENTED** (Dead queries) |
| `/am/quarters/:id/topics` | `POST` | [`admin.js:3135`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3135) | `requireAdmin` | Body: Topic fields, `video_url` | `INSERT INTO topics` | JSON `{ success, topic_id }` | **FULLY IMPLEMENTED** |
| `/am/topics/:id` | `POST` | [`admin.js:3180`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3180) | `requireAdmin` | Body: Topic fields | `UPDATE topics SET ...` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/topics/:id/toggle-lock` | `POST` | [`admin.js:3226`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3226) | `requireAdmin` | Body: `{ is_locked }` | `UPDATE topics SET is_locked = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/topics/:id` | `DELETE` | [`admin.js:3256`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3256) | `requireAdmin` | Param: `id` | Deletes topic, learning materials, unlinks questions | JSON `{ success }` | **PARTIALLY IMPLEMENTED** (Dead queries) |
| `/am/subjects/:id/classes` | `GET` | [`admin.js:3340`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3340) | `requireAdmin` | Param: `id` | `SELECT` from `classes`, `users` | JSON `{ success, classes }` | **FULLY IMPLEMENTED** |
| `/am/classes` | `POST` | [`admin.js:3384`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3384) | `requireAdmin` | Body: Section metadata | `INSERT INTO classes` | JSON `{ success, class_id }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id` | `POST` | [`admin.js:3438`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3438) | `requireAdmin` | Body: Section metadata | `UPDATE classes SET ...` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id` | `DELETE` | [`admin.js:3475`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3475) | `requireAdmin` | Param: `id` | `DELETE FROM class_students`, `DELETE FROM classes` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/config` | `GET` | [`admin.js:3505`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3505) | `requireAdmin` | Param: `id` | `SELECT` from `classes`, `class_whitelists` | JSON `{ success, settings, whitelists }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/settings` | `POST` | [`admin.js:3529`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3529) | `requireAdmin` | Body: Whitelist enums, dates, capacity | `UPDATE classes SET whitelist_enabled=?, max_capacity=?...` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/whitelist/upload` | `POST` | [`admin.js:3577`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3577) | `requireAdmin`, `uploadBulk` | Multipart file | `INSERT INTO class_whitelists`, sends emails | JSON `{ success, addedCount }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/whitelist/add` | `POST` | [`admin.js:3628`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3628) | `requireAdmin` | Body: `{ email, student_name, expirationDate }` | `INSERT INTO class_whitelists`, sends email | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/whitelist/remove` | `DELETE` | [`admin.js:3661`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3661) | `requireAdmin` | Body: `{ email }` | `DELETE FROM class_whitelists` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/students` | `GET` | [`admin.js:3682`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3682) | `requireAdmin` | Param: `id` | `SELECT` from `class_students` joined with `users` | JSON `{ success, students }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/unenroll` | `POST` | [`admin.js:3753`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3753) | `requireAdmin` | Body: `{ student_id }` | `DELETE FROM class_students`, updates `enrolled_count` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/migrate/targets` | `GET` | [`admin.js:3850`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3850) | `requireAdmin` | Query: `source_class_id` | `SELECT` classes available for transition | JSON `{ success, targets }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/migrate/preview` | `POST` | [`admin.js:3894`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3894) | `requireAdmin` | Body: `target_class_id`, `student_ids` | Validates timeframe, capacity, existing enrollment | JSON `{ success, preview }` | **FULLY IMPLEMENTED** |
| `/am/classes/:id/migrate` | `POST` | [`admin.js:3987`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L3987) | `requireAdmin` | Body: `target_class_id`, `student_ids`, `remove_from_source`, `force` | `INSERT INTO class_students`, deletes from source if requested, updates counts | JSON `{ success, migratedCount }` | **FULLY IMPLEMENTED** |
| `/am/subjects/:id/progress` | `GET` | [`admin.js:4119`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4119) | `requireAdmin` | Param: `id`, Query: `class_id` | `SELECT` from `student_progress`, `users` | JSON `{ success, progress }` | **FULLY IMPLEMENTED** |
| `/am/subjects/:id/announcements` | `GET` | [`admin.js:4179`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4179) | `requireAdmin` | Param: `id` | `SELECT` from `announcements` | JSON `{ success, announcements }` | **FULLY IMPLEMENTED** |
| `/am/announcements` | `POST` | [`admin.js:4215`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4215) | `requireAdmin` | Body: Announcement data | `INSERT INTO announcements`, dispatches notification | JSON `{ success, announcement_id }` | **FULLY IMPLEMENTED** |
| `/api/broadcast/global` | `POST` | [`admin.js:4280`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4280) | `requireAdmin`, `announcementUpload` | Multipart announcement | `INSERT INTO announcements`, pushes webhooks | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/api/webhooks` | `GET` | [`admin.js:4343`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4343) | `requireAdmin` | None | `SELECT` from `webhook_subscriptions` | JSON `{ success, webhooks }` | **MOCK / ORPHANED BACKEND** (Zero UI trigger) |
| `/api/webhooks` | `POST` | [`admin.js:4357`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4357) | `requireAdmin` | Body: `{ webhook_url, name }` | `INSERT INTO webhook_subscriptions` | JSON `{ success, id }` | **MOCK / ORPHANED BACKEND** (Zero UI trigger) |
| `/api/webhooks/:id` | `DELETE` | [`admin.js:4374`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4374) | `requireAdmin` | Param: `id` | `DELETE FROM webhook_subscriptions WHERE id = ?` | JSON `{ success }` | **MOCK / ORPHANED BACKEND** (Zero UI trigger) |
| `/am/announcements/:id` | `DELETE` | [`admin.js:4388`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4388) | `requireAdmin` | Param: `id` | `DELETE FROM announcements WHERE announcement_id = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/am/subjects/:id/leaderboard` | `GET` | [`admin.js:4421`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4421) | `requireAdmin` | Param: `id` | `SELECT` from `elementa_leaderboard` | JSON `{ success, history }` | **MOCK / ORPHANED BACKEND** (Zero UI trigger) |
| `/am/leaderboard/:id` | `DELETE` | [`admin.js:4452`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4452) | `requireAdmin` | Param: `id` | `DELETE FROM elementa_leaderboard`, touches dropped `leaderboard_history` | JSON `{ success }` | **MOCK / ORPHANED BACKEND** (Zero UI trigger) |
| `/am/subjects/:id/matches` | `GET` | [`admin.js:4488`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4488) | `requireAdmin` | Param: `id` | `SELECT` from `elementa_game_sessions` | JSON `{ success, matches }` | **BROKEN / GHOST UI** (`#matchesContainer` never calls it) |
| `/am/matches/:id` | `DELETE` | [`admin.js:4530`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4530) | `requireAdmin` | Param: `id` | `DELETE FROM elementa_game_sessions` | JSON `{ success }` | **BROKEN / GHOST UI** (Zero UI trigger) |
| `/am/button-mappings` | `GET` | [`admin.js:4573`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4573) | `requireAdmin` | None | `SELECT` from `button_mappings` | JSON `{ success, mappings }` | **BROKEN / GHOST UI** (`#mappingContainer` never calls it) |
| `/am/button-mappings` | `POST` | [`admin.js:4593`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4593) | `requireAdmin` | Body: Mapping config | `INSERT INTO button_mappings` | JSON `{ success, mapping_id }` | **BROKEN / GHOST UI** (`submitAddMapping` missing) |
| `/am/button-mappings/:id` | `DELETE` | [`admin.js:4635`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4635) | `requireAdmin` | Param: `id` | `DELETE FROM button_mappings` | JSON `{ success }` | **BROKEN / GHOST UI** (Zero UI trigger) |
| `/am/bulk-subjects` | `POST` | [`admin.js:4669`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4669) | `requireAdmin`, `uploadBulk` | Multipart Excel | Parses and inserts `subjects` | JSON `{ success, created, errors }` | **FULLY IMPLEMENTED** |
| `/am/bulk-enroll` | `POST` | [`admin.js:4770`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4770) | `requireAdmin`, `uploadBulk` | Multipart Excel | Validates LRNs, inserts `class_students` | JSON `{ success, enrolled, errors }` | **FULLY IMPLEMENTED** |
| `/am/bulk-template` | `GET` | [`admin.js:4883`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4883) | `requireAdmin` | Query: `type=curriculum\|enrollment` | Builds workbook with instructions | Binary Download `.xlsx` | **FULLY IMPLEMENTED** |

---

### Module D: Gaming & Question Bank (Arcade Assessments & Hardware Mappings)
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/gaming_question_bank` | `GET` | [`admin.js:4968`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4968) | `requireAdmin` | None | `SELECT` from `assessments`, `elementa_questions`, `button_mappings`, `remediation_materials`, `topics` | Renders `admin/gaming_qbank` | **FULLY IMPLEMENTED** |
| `/gqb/assessments/:id` | `GET` | [`admin.js:5166`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5166) | `requireAdmin` | Param: `id` | `SELECT` from `assessments`, `elementa_assessment_questions` | JSON `{ success, assessment, questions }` | **FULLY IMPLEMENTED** |
| `/gqb/topics/:topic_id/questions-pool` | `GET` | [`admin.js:5204`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5204) | `requireAdmin` | Param: `topic_id` | `SELECT` from `elementa_questions WHERE topic_id = ?` | JSON `{ success, questions }` | **FULLY IMPLEMENTED** |
| `/gqb/assessments` | `POST` | [`admin.js:5241`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5241) | `requireAdmin` | Body: Assessment fields + question IDs | `INSERT INTO assessments`, `INSERT INTO elementa_assessment_questions` | JSON `{ success, assessment_id }` | **FULLY IMPLEMENTED** (Teacher Boundary Overlap) |
| `/gqb/assessments/:id` | `PUT` | [`admin.js:5313`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5313) | `requireAdmin` | Body: Assessment fields + question IDs | `UPDATE assessments`, syncs `elementa_assessment_questions` | JSON `{ success }` | **FULLY IMPLEMENTED** (Teacher Boundary Overlap) |
| `/gqb/assessments/:id/toggle-lock` | `POST` | [`admin.js:5384`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5384) | `requireAdmin` | Body: `{ is_locked }` | `UPDATE assessments SET is_locked = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/assessments/:id` | `DELETE` | [`admin.js:5403`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5403) | `requireAdmin` | Param: `id` | `DELETE FROM assessments`, `elementa_assessment_questions`, touches dropped tables in try/catch | JSON `{ success }` | **PARTIALLY IMPLEMENTED** (Dead queries) |
| `/gqb/questions` | `POST` | [`admin.js:5441`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5441) | `requireAdmin` | Body: Question fields | `INSERT INTO elementa_questions` (auto-approved) | JSON `{ success, question_id }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/:id` | `PUT` | [`admin.js:5451`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5451) | `requireAdmin` | Body: Question fields | `UPDATE elementa_questions` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/:id` | `DELETE` | [`admin.js:5579`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5579) | `requireAdmin` | Param: `id` | `UPDATE elementa_questions SET is_active = 0` (soft delete) | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/bulk-delete` | `POST` | [`admin.js:5597`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5597) | `requireAdmin` | Body: `{ ids: number[] }` | `UPDATE elementa_questions SET is_active = 0 WHERE question_id IN (?)` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/bulk-approve` | `POST` | [`admin.js:5613`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5613) | `requireAdmin` | Body: `{ ids: number[] }` | `UPDATE elementa_questions SET verification_status='Approved'` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/mappings` | `POST` | [`admin.js:5638`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5638) | `requireAdmin` | Body: Hardware pin mappings | `INSERT INTO button_mappings` | JSON `{ success, mapping_id }` | **FULLY IMPLEMENTED** |
| `/gqb/mappings/:id` | `PUT` | [`admin.js:5661`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5661) | `requireAdmin` | Body: Hardware pin mappings | `UPDATE button_mappings` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/mappings/:id` | `DELETE` | [`admin.js:5690`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5690) | `requireAdmin` | Param: `id` | `DELETE FROM button_mappings WHERE mapping_id = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/remediation/:question_id` | `GET` | [`admin.js:5714`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5714) | `requireAdmin` | Param: `question_id` | `SELECT` from `remediation_materials` | JSON `{ success, remediation }` | **FULLY IMPLEMENTED** |
| `/gqb/remediation` | `POST` | [`admin.js:5725`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5725) | `requireAdmin` | Body: Remediation data | `INSERT INTO remediation_materials` | JSON `{ success, rem_id }` | **FULLY IMPLEMENTED** |
| `/gqb/remediation/:id` | `PUT` | [`admin.js:5730`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5730) | `requireAdmin` | Body: Remediation data | `UPDATE remediation_materials`, legacy fallback | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/remediation/:id` | `DELETE` | [`admin.js:5780`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5780) | `requireAdmin` | Param: `id` | `DELETE FROM remediation_materials WHERE rem_id = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/:id/approve` | `POST` | [`admin.js:5797`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5797) | `requireAdmin` | Param: `id` | `UPDATE elementa_questions SET verification_status='Approved'`, dispatches Teacher notification | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/:id/reject` | `POST` | [`admin.js:5866`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5866) | `requireAdmin` | Body: `{ reason }` | `UPDATE elementa_questions SET verification_status='Rejected'`, dispatches Teacher notification | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/preflight` | `POST` | [`admin.js:5946`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5946) | `requireAdmin`, `uploadBulk` | Multipart Excel | Validates rows against schema, enums, duplicates | JSON `{ success, summary, rows }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/bulk-import` | `POST` | [`admin.js:6058`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6058) | `requireAdmin`, `uploadBulk` | Multipart Excel | Inserts into `elementa_questions` (auto-approved) | JSON `{ success, created, skipped, errors }` | **FULLY IMPLEMENTED** |
| `/gqb/questions/template` | `GET` | [`admin.js:6254`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6254) | `requireAdmin` | None | Builds stylized multi-tab Excel template with dropdown validations | Binary Download `.xlsx` | **FULLY IMPLEMENTED** |

---

### Module E: Resources & Community Engagement
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/resources_engagement` | `GET` | [`admin.js:6372`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6372) | `requireAdmin` | None | `SELECT` from `learning_materials`, `discussion_forums`, `forum_replies`, `elementa_leaderboard` | Renders `admin/resources_engagement` | **FULLY IMPLEMENTED** |
| `/re/materials` | `POST` | [`admin.js:6845`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6845) | `requireAdmin`, `multer` | Multipart / Body: Material data | `INSERT INTO learning_materials` | JSON `{ success, material_id }` | **FULLY IMPLEMENTED** (Teacher Boundary Overlap) |
| `/re/materials/:id` | `PUT` | [`admin.js:6963`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6963) | `requireAdmin` | Body: `{ title, topic_id, is_locked }` | `UPDATE learning_materials SET ...` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/materials/:id/toggle-lock` | `POST` | [`admin.js:7006`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7006) | `requireAdmin` | Param: `id` | `UPDATE learning_materials SET is_locked = NOT is_locked` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/materials/:id` | `DELETE` | [`admin.js:7035`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7035) | `requireAdmin` | Param: `id` | `DELETE FROM learning_materials WHERE material_id = ?`, unlinks files | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/forums` | `POST` | [`admin.js:7083`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7083) | `requireAdmin` | Body: Forum fields | `INSERT INTO discussion_forums` | JSON `{ success, forum_id }` | **FULLY IMPLEMENTED** (Teacher Boundary Overlap) |
| `/re/forums/:id` | `PUT` | [`admin.js:7137`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7137) | `requireAdmin` | Body: Forum fields | `UPDATE discussion_forums SET ...` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/forums/:id` | `DELETE` | [`admin.js:7178`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7178) | `requireAdmin` | Param: `id` | `DELETE FROM discussion_forums WHERE forum_id = ?` (cascades replies) | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/forum/reply/:replyId/reveal` | `POST` | [`admin.js:7214`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7214) | `requireAdmin` | Body: `{ reason }` | `SELECT` real author, `INSERT INTO forum_unmask_audit` | JSON `{ success, realAuthor }` | **FULLY IMPLEMENTED** |
| `/api/forum-unmask-logs` | `GET` | [`admin.js:7257`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7257) | `requireAdmin` | None | `SELECT` from `forum_unmask_audit` | JSON `{ success, logs }` | **FULLY IMPLEMENTED** |
| `/re/forum/reply/:replyId/reset-votes` | `POST` | [`admin.js:7281`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7281) | `requireAdmin` | Param: `replyId` | `DELETE FROM forum_reply_votes WHERE reply_id = ?`, `UPDATE forum_replies SET upvotes=0, downvotes=0` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/replies/:id` | `DELETE` | [`admin.js:7320`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7320) | `requireAdmin` | Param: `id` | `DELETE FROM forum_replies WHERE reply_id = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/re/interactions` | `GET` | [`admin.js:7354`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7354) | `requireAdmin` | Query: `material_id` | `SELECT` from `student_material_interactions`, `users` | JSON `{ success, interactions }` | **FULLY IMPLEMENTED** |
| `/re/analytics/date-engagement` | `GET` | [`admin.js:7401`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7401) | `requireAdmin` | Query: `start_date`, `end_date` | Aggregates logins, forum replies, and arcade attempts by day | JSON `{ success, series }` | **FULLY IMPLEMENTED** |
| `/re/activity-feed` | `GET` | [`admin.js:7640`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7640) | `requireAdmin` | None | `SELECT` recent LMS & Arcade event timeline | JSON `{ success, feed }` | **FULLY IMPLEMENTED** |
| `/re/leaderboard` | `GET` | [`admin.js:7669`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7669) | `requireAdmin` | None | `SELECT` from `elementa_leaderboard`, `users` | JSON `{ success, leaderboard }` | **FULLY IMPLEMENTED** |
| `/re/leaderboard-history` | `GET` | [`admin.js:7694`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7694) | `requireAdmin` | None | `SELECT` from `elementa_leaderboard` | JSON `{ success, history }` | **FULLY IMPLEMENTED** |

---

### Module F: Institutional Reports & Monitoring
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/reports_monitoring` | `GET` | [`admin.js:7747`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7747) | `requireAdmin` | None | Aggregates classes, grade distributions, student stats, and curriculum trees | Renders `admin/reports_monitoring` | **FULLY IMPLEMENTED** |
| `/rm/export/curriculum` | `GET` | [`admin.js:8022`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8022) | `requireAdmin` | Query: `format=pdf\|excel` | `SELECT` subjects, quarters, topics, learning materials | PDF or Excel Document stream | **FULLY IMPLEMENTED** |
| `/rm/export/class-summary` | `GET` | [`admin.js:8104`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8104) | `requireAdmin` | Query: `format=pdf\|excel` | `SELECT` all classes, enrolled counts, teacher assignments | PDF or Excel Document stream | **FULLY IMPLEMENTED** |
| `/rm/export/class/:id` | `GET` | [`admin.js:8210`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8210) | `requireAdmin` | Param: `id`, Query: `format` | `SELECT` class roster, students, scores | PDF or Excel Document stream | **FULLY IMPLEMENTED** |
| `/rm/export/student/:id` | `GET` | [`admin.js:8332`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8332) | `requireAdmin` | Param: `id`, Query: `format` | `SELECT` student record, class enrolled, arcade performance, progress | PDF or Excel Document stream | **FULLY IMPLEMENTED** |
| `/rm/export/students-all` | `GET` | [`admin.js:8519`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8519) | `requireAdmin` | Query: `status`, `format` | `SELECT` master list of all registered students | PDF or Excel Document stream | **FULLY IMPLEMENTED** |
| `/rm/test-paper` | `GET` | [`admin.js:8642`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8642) | `requireAdmin` | Query: `ids`, `title` | `SELECT` from `elementa_questions` | Formatted Print Document (PDF) | **PARTIALLY IMPLEMENTED** (Blank multiple choice options `A. — B. —`) |

---

### Module G: System Audit, Security & Compliance
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/system_audit` | `GET` | [`admin.js:8857`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8857) | `requireAdmin` | Query: `search`, `role`, `action`, `page` | `SELECT` paginated rows from `activity_logs` joined with `users` | Renders `admin/system_audit` | **FULLY IMPLEMENTED** |
| `/system_audit/export` | `GET` | [`admin.js:9270`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9270) | `requireAdmin` | Query: filters | `SELECT` from `activity_logs` | PDF Document stream | **FULLY IMPLEMENTED** |
| `/api/annotations/:annotation_id` | `DELETE` | [`admin.js:9371`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9371) | `requireAdmin` | Param: `annotation_id` | `DELETE FROM student_submission_annotations WHERE annotation_id = ?` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/api/answer-query` | `POST` | [`admin.js:9381`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9381) | `requireAdmin` | Body: `{ query_id, admin_response }` | `UPDATE student_answer_queries SET admin_response = ?, status = 'Resolved'` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/api/annotations/:annotation_id/approve` | `POST` | [`admin.js:9398`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9398) | `requireAdmin` | Param: `annotation_id` | `UPDATE student_submission_annotations SET status = 'Approved'` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/api/annotations/:annotation_id/reject` | `POST` | [`admin.js:9408`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9408) | `requireAdmin` | Param: `annotation_id` | `UPDATE student_submission_annotations SET status = 'Rejected'` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/api/receipts/verify/:hash` | `GET` | [`admin.js:9447`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9447) | `requireAdmin` | Param: `hash` | `SELECT` from `student_submission_receipts` joined with `users`, `assessments` | JSON `{ verified, receipt }` | **FULLY IMPLEMENTED** |
| `/api/receipts/recent` | `GET` | [`admin.js:9470`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9470) | `requireAdmin` | None | `SELECT` last 25 records from `student_submission_receipts` | JSON `{ success, receipts }` | **FULLY IMPLEMENTED** |
| `/api/settings/grace-buffer` | `POST` | [`admin.js:9488`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9488) | `requireAdmin` | Body: `{ bufferMinutes }` | `UPDATE system_settings SET setting_value = ? WHERE setting_key = 'submission_grace_buffer_minutes'` | JSON `{ success }` | **FULLY IMPLEMENTED** |
| `/api/storage/audit` | `GET` | [`admin.js:9515`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9515) | `requireAdmin` | None | Scans physical directories on disk vs DB references (`profile_pics`, `material_uploads`, `assignment_templates`) | JSON `{ success, audit }` | **FULLY IMPLEMENTED** |
| `/api/storage/cleanup-orphans` | `POST` | [`admin.js:9638`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9638) | `requireAdmin` | Body: `{ dryRun, targetFiles }` | Deletes unreferenced disk files with directory containment guard | JSON `{ success, deletedCount }` | **FULLY IMPLEMENTED** |

---

### Module H: Hardware Fleet Monitor
| Route | Method | File & Line | Middleware | Request Payload | Database Operations | Response | Maturity Status |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `/arcade-hardware-monitor` | `GET` | [`admin.js:9708`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9708) | `requireAdmin` | None | `SELECT` from `elementa_kiosk_status`, psychometrics via `arcadeAnalyticsService`, fleet session totals | Renders `admin/arcade_hardware_monitor` | **FULLY IMPLEMENTED** |

---

## 3. UI & Domain Boundary Audit

### A. Template & Control Inventory
The 8 admin templates and 1 invite template provide UI controls across modals, forms, and fetch bindings:
1. [`views/admin/dashboard.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs): 1,267 lines. High-level institutional KPIs, submission charts, leaderboard snapshots, and alert badges.
2. [`views/admin/user_access_control.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/user_access_control.ejs): 4,057 lines. User directory, invite creation modal, bulk Excel modal, suspension/archive actions, QR regeneration, Google unlinking.
3. [`views/admin/academic_management.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs): 3,794 lines. School year manager, subject drill-down, quarter/topic editors, class/section manager, whitelist upload/add, student migration wizard, global announcement modal.
4. [`views/admin/gaming_qbank.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/gaming_qbank.ejs): 3,514 lines. Two-tier assessment manager, question pool picker, arcade question creator/editor, Excel preflight and bulk importer, hardware pin mapper, remediation material mapper.
5. [`views/admin/resources_engagement.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/resources_engagement.ejs): 4,471 lines. Multi-format material uploader, discussion forum creator, anonymous post unmasking modal, interaction activity logs, engagement analytics charts.
6. [`views/admin/reports_monitoring.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/reports_monitoring.ejs): 1,189 lines. Instant PDF/Excel exports for curriculum, class summaries, single rosters, student transcripts, master lists, test paper builder.
7. [`views/admin/system_audit.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/system_audit.ejs): 2,130 lines. Paginated activity logs, filter controls, PDF audit report exporter, orphan file scanner and cleanup modal, grace buffer slider, SHA-256 submission receipt verifier.
8. [`views/admin/arcade_hardware_monitor.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/arcade_hardware_monitor.ejs): 400 lines. Kiosk cabinet cards, WebSocket telemetry indicators, question psychometric difficulty/discrimination tables, recent session gradebook reconciliations.
9. [`views/admin-invite.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin-invite.ejs): 137 lines. Prototype invite form submitting to `/admin/invite`.

---

### B. Flagged "Ghost Elements" & Broken Client Bindings
The following UI controls exist in templates but fail on interaction:

| UI File & Line | Control Element | Target Action | Exact Failure Cause |
| :--- | :--- | :--- | :--- |
| [`dashboard.ejs:321`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs#L321) | `<a href="/admin/school-years">Manage →</a>` | `/admin/school-years` | **404 Not Found**. Route does not exist. (Correct path: `/admin/academic_management`). |
| [`dashboard.ejs:344`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs#L344) | `<a href="/admin/school-years">Set one now →</a>` | `/admin/school-years` | **404 Not Found**. Route does not exist. |
| [`dashboard.ejs:406`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs#L406) | `<a href="/admin/calendar">View →</a>` | `/admin/calendar` | **404 Not Found**. Calendar route does not exist in Admin subsystem. |
| [`dashboard.ejs:450`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs#L450) | `<a href="/admin/performance">All →</a>` | `/admin/performance` | **404 Not Found**. Route does not exist. (Correct path: `/admin/reports_monitoring`). |
| [`dashboard.ejs:491`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs#L491) | `<a href="/admin/activity-logs">Full Logs →</a>` | `/admin/activity-logs` | **404 Not Found**. Route does not exist. (Correct path: `/admin/system_audit`). |
| [`dashboard.ejs:678`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs#L678) | `<a href="/admin/arcade">All →</a>` | `/admin/arcade` | **404 Not Found**. Route does not exist. (Correct path: `/admin/arcade-hardware-monitor`). |
| [`academic_management.ejs:617`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L617) | `<div id="matchesContainer">` | Container for match history | **Permanently Blank**. Template text "Select a subject to load match history" never updates; client JS never issues requests to `/am/subjects/:id/matches`. |
| [`academic_management.ejs:633`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L633) | `<div id="mappingContainer">` | Container for hardware pins | **Permanently Blank**. Displays "Loading hardware mappings…"; client JS never issues requests to `/am/button-mappings`. |
| [`academic_management.ejs:1212`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L1212) | `<form id="addMappingForm" onsubmit="submitAddMapping(event)">` | `submitAddMapping(event)` | **Uncaught ReferenceError: submitAddMapping is not defined**. Saving hardware mapping in AM fails immediately in client browser. |
| [`academic_management.ejs:1193`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L1193) | `<input type="checkbox" name="forward_webhook">` | Webhook subscription forwarding | **No Configuration Interface**. Checkbox exists, but Admin UI has zero screens to view or register webhooks (`/api/webhooks` is headless). |

---

### C. Domain Boundary Analysis
Auditing the role responsibilities across the platform highlights several boundary overlaps:

1. **Accidental Teacher Tasks Hosted in Admin:**
   - **Assessment Creation & Configuration ([`admin.js:5241`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L5241)):** Admin can directly construct assessment records, assign questions, set time limits, and bind them to quarters. While useful for global system benchmarking, curricular assessment creation is a core Teacher function.
   - **Learning Materials Upload ([`admin.js:6845`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6845)):** Uploading lecture slides, audio notes, and PDFs to `learning_materials` is an educational delivery function rather than system infrastructure maintenance.
   - **Classroom Discussion Boards ([`admin.js:7083`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7083)):** Admin can create topic-specific discussion forums, which duplicates the Teacher's class forum manager.

2. **Accidental Public Task Exposing Admin Provisioning:**
   - **Unprotected Invite Form ([`app.js:180-264`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js#L180-L264)):** `GET /admin-invite` and `POST /admin/invite` are completely unauthenticated. Anyone who discovers the URL can provision accounts and send emails.

3. **Duplicated & Misplaced System Boundaries:**
   - **ESP32 Hardware Pin Mappings in Academic Management:** Hardware pin mapping belongs exclusively to Hardware Monitor / Arcade Lab. In `academic_management.ejs`, it represents a broken duplicate of the functional mapper in `gaming_qbank.ejs`.

---

## 4. Downstream Cascade & Data Integrity

When an Administrator performs administrative mutations, the following cascade effects and data integrity issues occur:

### A. Section & Academic Provisioning Cascades
- **Creating a School Year (`POST /am/school-years`):**  
  Activating an SY sets all other records to `is_active = 0`. This cascades correctly to Teacher and Student dropdowns because queries in `teacher.js` and `student.js` filter by active school years.
- **Creating / Updating Classes (`POST /am/classes`):**  
  Requires `teacher_id`, `subject_id`, `sy_id`. The section immediately appears in the assigned teacher's portal (`/teacher/sections`) and displays enrollment capacity limits.
- **Enrolling Students via Bulk Import / Migration (`POST /am/classes/:id/migrate`):**  
  Migration correctly checks `enrollment_start`, `enrollment_end`, and `max_capacity`. When students are moved, `enrolled_count` updates on both source and target classes.  
  *Integrity Gap:* If a student is migrated to a class with a different `subject_id`, no record is created in `student_progress` for the new subject. The student must open the subject view before a progress row is initialized.

### B. User Deletion & Dangling References (`DELETE /uac/users/:id`)
When an Admin deletes a user at [`admin.js:1288`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1288):
1. **Teacher Deletion:**
   - The deletion executes `UPDATE classes SET teacher_id = NULL WHERE teacher_id = ?`. Classes remain in the database without an assigned teacher.
   - Materials uploaded by the teacher have `UPDATE learning_materials SET teacher_id = NULL WHERE teacher_id = ?`.
2. **Student Deletion:**
   - Correctly deletes from `class_students`, `student_progress`, `student_material_interactions`, `forum_replies`, `student_forum_done`, `private_messages`, `student_submission_receipts`, and `student_answer_queries`.
   - *Dead Queries:* Code attempts to delete from dropped tables:
     ```sql
     DELETE FROM student_responses WHERE score_id IN (?);
     DELETE FROM active_sessions WHERE student_id = ?;
     DELETE FROM competitive_matches WHERE p1_id = ? OR p2_id = ? OR winner_id = ?;
     DELETE FROM leaderboard_history WHERE student_id = ?;
     ```
     Because these are wrapped in `try { ... } catch (_) {}`, execution proceeds, but these statements are dead legacy queries.

### C. Curricular Deletion Cascades (`DELETE /am/subjects/:id`, `DELETE /am/quarters/:id`)
1. Deleting a Subject unlinks questions from topics (`UPDATE elementa_questions SET topic_id = NULL WHERE topic_id IN (?)`) to prevent arcade question loss.
2. Deleting an assessment unlinks arcade sessions:
   ```sql
   UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id = ?;
   DELETE FROM elementa_assessment_questions WHERE assessment_id = ?;
   DELETE FROM elementa_assessment_tickets WHERE assessment_id = ?;
   ```
   This ensures that students' historical gameplay records and high scores in `elementa_game_sessions` are preserved even if an assessment container is removed.

---

## 5. Actionable Verdict & Intervention Matrix

| Feature / Screen | Route & UI Target | Current Maturity Status | Architectural Boundary | Action Required | Risk Level for Defense |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Legacy Invite Routes** | `GET /admin-invite`, `POST /admin/invite` ([`app.js:180-187`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js#L180-L187)) | **BROKEN / SECURITY LEAK** | Public / Dead Prototype | **SAFE DROP**: Remove both routes and delete `views/admin-invite.ejs`. All invites must use `/admin/uac/invite`. | **HIGH** |
| **Dashboard Navigation Cards** | Links to `/admin/school-years`, `/calendar`, `/performance`, `/activity-logs`, `/arcade` ([`dashboard.ejs:321, 406, 450, 491, 678`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs)) | **BROKEN / DESYNCED** | Admin | **KEEP & POLISH**: Update `href` targets in `dashboard.ejs` to point to `/admin/academic_management`, `/admin/reports_monitoring`, `/admin/system_audit`, and `/admin/arcade-hardware-monitor`. | **HIGH** |
| **Hardware Mapping in Academic Management** | `#mappingContainer`, `modalAddMapping`, `submitAddMapping(event)` ([`academic_management.ejs:622, 1212`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L622)) | **BROKEN / GHOST UI** | Misplaced Duplicate | **SAFE DROP**: Remove the abandoned hardware mapping panel and modal from `academic_management.ejs`. Hardware mapping is fully functional in `gaming_qbank.ejs`. | **HIGH** |
| **Competitive Matches in Academic Management** | `#matchesContainer`, `GET /am/subjects/:id/matches` ([`academic_management.ejs:610`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs#L610)) | **MOCK / PLACEHOLDER** | Misplaced Duplicate | **SAFE DROP**: Remove `#matchesContainer` from `academic_management.ejs`. Arcade sessions are already monitored in `arcade_hardware_monitor.ejs`. | **MED** |
| **Test Paper Option Blanking** | `GET /admin/rm/test-paper` ([`admin.js:8642`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8642)) | **PARTIALLY IMPLEMENTED** | Admin Reports | **COMPLETE BACKEND**: Parse options from `eq.steps_json` for Godot questions so that options A, B, C, D print correctly instead of returning `—`. | **MED** |
| **Webhook Management Subsystem** | `GET/POST/DELETE /api/webhooks` ([`admin.js:4343-4374`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4343-L4374)) | **MOCK / ORPHANED BACKEND** | System Integration | **COMPLETE BACKEND OR DROP**: Either provide a UI modal in `system_audit.ejs` to register webhooks, or remove the webhook routes and checkbox if unused in defense. | **MED** |
| **Dropped Table Queries in Cascade Deletions** | 11 deletion routes in `admin.js` targeting `student_responses`, `active_sessions`, etc. | **PARTIALLY IMPLEMENTED** | Legacy Dead Code | **KEEP & POLISH**: Purge dead SQL delete queries from `routes/admin.js` lines 1321, 2805, 2826, 3087, 4464, 4549, 5418. | **LOW** |
| **User Access Control & Identity Engine** | `/user_access_control`, `/uac/invite`, `/uac/bulk-import`, toggle status, reset QR/Password ([`admin.js:392-2402`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L392-L2402)) | **FULLY IMPLEMENTED** | Core Admin | **KEEP & POLISH**: Production-ready. Maintain as core defense demonstration. | **LOW** |
| **Academic Management (SY, Sections, Migration, Whitelist)** | `/academic_management`, `/am/school-years`, `/am/classes`, `/am/classes/:id/migrate`, whitelists ([`admin.js:2403-4100`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L2403-L4100)) | **FULLY IMPLEMENTED** | Core Admin | **KEEP & POLISH**: Production-ready with validation and audit logging. | **LOW** |
| **Arcade Question Bank & Bulk Preflight** | `/gaming_question_bank`, `/gqb/questions`, Excel preflight & import ([`admin.js:4968-6370`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4968-L6370)) | **FULLY IMPLEMENTED** | Shared Admin / Arcade Lab | **KEEP & POLISH**: Dynamic validation rules and error logs are fully operational. | **LOW** |
| **Resources & Community Moderation** | `/resources_engagement`, unmasking audit, reset votes, materials, forums ([`admin.js:6372-7746`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6372-L7746)) | **FULLY IMPLEMENTED** | Shared Admin / Teacher | **KEEP & POLISH**: Fully functional moderation tools. Note teacher boundary overlap in defense. | **LOW** |
| **Reports & Export Generator** | `/reports_monitoring`, `/rm/export/*` ([`admin.js:7747-8640`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7747-L8640)) | **FULLY IMPLEMENTED** | Core Admin | **KEEP & POLISH**: Institutional PDF and Excel generation meets formatting standards. | **LOW** |
| **System Audit, Storage & Ledger** | `/system_audit`, `/api/storage/*`, `/api/receipts/*`, grace buffer ([`admin.js:8857-9700`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8857-L9700)) | **FULLY IMPLEMENTED** | Core Admin Compliance | **KEEP & POLISH**: High-value defense demonstration showing audit trails and SHA-256 receipt verification. | **LOW** |
| **ESP32 Hardware & Kiosk Fleet Monitor** | `/arcade-hardware-monitor` ([`admin.js:9708-9765`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L9708-L9765)) | **FULLY IMPLEMENTED** | Core Admin Hardware | **KEEP & POLISH**: Telemetry monitor, psychometric item statistics, and gradebook reconciliation table are operational. | **LOW** |

---

## 6. Recommended Pre-Defense Action Plan

To prepare the Admin subsystem for evaluation and defense, execute the following four targeted refactorings:

1. **Eliminate Public Security Risk:**
   - In [`app.js`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/app.js#L180-L264), delete `GET /admin-invite` and `POST /admin/invite`.
   - Delete the unauthenticated prototype file [`views/admin-invite.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin-invite.ejs).
2. **Resolve Main Dashboard 404s:**
   - In [`views/admin/dashboard.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/dashboard.ejs), redirect dead navigation links:
     - `/admin/school-years` &rarr; `/admin/academic_management`
     - `/admin/calendar` &rarr; Remove button or redirect to `/admin/academic_management`
     - `/admin/performance` &rarr; `/admin/reports_monitoring`
     - `/admin/activity-logs` &rarr; `/admin/system_audit`
     - `/admin/arcade` &rarr; `/admin/arcade-hardware-monitor`
3. **Purge Ghost Elements in Academic Management:**
   - In [`views/admin/academic_management.ejs`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/views/admin/academic_management.ejs), delete `#matchesContainer`, `#mappingContainer`, and `modalAddMapping`.
   - In [`routes/admin.js`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L4573-L4635), drop `/am/button-mappings` routes (leaving `/gqb/mappings` as the single source of truth).
4. **Fix Test Paper Option Parsing:**
   - In [`routes/admin.js:8656-8697`](file:///c:/Users/althe/OneDrive/Pictures/LMS%20GAME%20ESP32%20SETUP/chemistry_lms_backup%20-%20Copy/routes/admin.js#L8656-L8697), parse `steps_json` for multiple-choice options so printed exam papers render option text properly.
