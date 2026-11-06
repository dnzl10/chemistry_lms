Act as a Senior Full-Stack Software Architect and Code Auditor.

I have provided the complete codebase and project files of our Learning Management System (LMS) web application. Your task is to perform a rigorous code audit and architectural verification against five (5) specific forum and discussion board features. 

Specifically, you must audit whether:
1. The technical safeguards, database constraints, and legal considerations are met.
2. The specific role-based access control (RBAC) capabilities for Students, Teachers, and Admins are strictly enforced across backend routes/controllers, middleware, and front-end views.

Please inspect all relevant layers:
- Database Migrations / Schemas / DDL / Models
- Authentication, Authorization Middleware, Routes, and Controllers
- Front-end Views / Templates / Client-side Scripts / API Consumers

---

### Audit Criteria & Feature Breakdown:

#### 1. Anonymous Posting Mode (Pseudonymous Q&A)
* **Safeguards to Verify:**
  - Database stores genuine `user_id` alongside `is_anonymous` (pseudonymity, not orphan posts).
  - Server-side payload sanitization: Peer students NEVER receive the author's `user_id`, real name, or avatar via JSON/view responses.
  - Break-glass audit logging: Unmasking an identity creates a record in an `audit_logs` table (`admin_id`, `target_post_id`, `justification`, `timestamp`).
* **Role Capabilities to Audit:**
  - **Student:** Can toggle "Post as Anonymous"; sees their own post as "You (Anonymous)"; sees others' anonymous posts only as "Anonymous Student". Cannot see authors' true identities.
  - **Teacher:** Sees "Anonymous Student" by default; has a privilege/button to reveal the author's identity for academic moderation.
  - **Admin:** Has global permission to unmask/audit the true author; can review all unmasking logs.

#### 2. Thread Status Tracking (Unresolved vs. Solved)
* **Safeguards to Verify:**
  - Explicit workflow state (`status` enum or boolean) in the database.
  - Database index applied on `status` (`INDEX(status)`) for high-performance filtering.
  - Role-based state precedence: Instructor has higher authority over the status than the student author.
* **Role Capabilities to Audit:**
  - **Student (Author):** Can mark their own thread as "Solved" once satisfied, or revert to "Unresolved". Cannot change status of other students' threads.
  - **Student (Non-Author):** Can filter threads by status; cannot toggle status of others' threads.
  - **Teacher:** Can override and force-toggle the status of ANY thread (e.g., revert false "Solved" threads to "Unresolved", or promote to "Instructor-Verified"); can filter dashboard by unaddressed threads.
  - **Admin:** Global override; bulk status updates or thread archiving.

#### 3. Instructor-Endorsed / Accepted Answer
* **Safeguards to Verify:**
  - Single accepted/endorsed answer enforced per thread (via atomic transactions or unique constraints).
  - Immutability lock: Endorsed replies cannot be edited or deleted by the student author (returns HTTP 403 Forbidden).
  - UI order: Endorsed answers are pinned/sorted to the top of the reply list.
* **Role Capabilities to Audit:**
  - **Student (Author):** Can select/accept a helpful peer reply as "Accepted Answer". CANNOT mark any reply as "Instructor-Endorsed".
  - **Student (Non-Author):** Can view endorsed/accepted badges; cannot endorse or accept replies.
  - **Teacher:** Exclusive capability to apply the official "Instructor-Endorsed" badge (which overrides regular student acceptance); can revoke or change the endorsement.
  - **Admin:** Has administrative override to resolve disputes or reassign instructor endorsements.

#### 4. Contextual Lesson Tagging
* **Safeguards to Verify:**
  - Foreign key safety: `lesson_id` foreign key configured with `ON DELETE SET NULL` (not `CASCADE`), preventing mass discussion wipeout when lessons are updated/deleted.
  - Scope verification: Backend validates that the `lesson_id` belongs to an active course the student is currently enrolled in.
* **Role Capabilities to Audit:**
  - **Student:** Can select a lesson tag from an enrolled course when creating a thread; can filter forum threads by lesson/module.
  - **Teacher:** Can edit or reassign incorrect module tags on student threads; can link direct discussions from lesson materials.
  - **Admin:** Manages master lesson/module catalog and available categories.

#### 5. Peer Upvoting & Contributor Badging
* **Safeguards to Verify:**
  - Isolated join table (`reply_votes`) with a composite unique constraint (`UNIQUE(reply_id, user_id)`) to prevent duplicate vote exploits (no raw incrementing counters).
  - Server-side check preventing authors from voting on their own replies (anti-self-voting).
  - Decoupled logic: "Top Contributor" calculations must not automatically modify academic grades without teacher intervention.
* **Role Capabilities to Audit:**
  - **Student:** Can upvote/toggle upvotes on replies by peers or teachers (1 vote limit); CANNOT upvote own replies; can earn a "Top Contributor" badge upon reaching thresholds.
  - **Teacher:** Can upvote replies (with optional distinct visual marker like "Teacher Upvoted"); can view vote metrics to inform manual participation grades.
  - **Admin:** Can reset vote tallies, configure threshold values, or revoke badges in cases of vote manipulation.

---

### Expected Output Structure:

1. **RBAC & Feature Implementation Matrix**:
   - Provide a clean Markdown summary table displaying:
     `Feature | Student Access | Teacher Access | Admin Access | Backend Safeguards | Overall Status`
     (Mark with `[Implemented]`, `[Partially Implemented]`, or `[Missing]`).

2. **Per-Feature Code Audit Breakdown**:
   - For each of the 5 features, evaluate:
     - **File Traces:** Reference the exact files, controllers, middleware, queries, and templates implementing this feature.
     - **RBAC Enforcement Check:** Detail whether Student, Teacher, and Admin permissions are properly segregated or if role escalation vulnerabilities exist.
     - **Technical Safeguards & Vulnerabilities:** Highlight any missed constraints (e.g., exposed IDs in client responses, missing database indexes, missing `ON DELETE SET NULL`, race conditions).
     - **Concrete Recommendations / Code Fixes:** Provide drop-in code snippets (SQL migration statements, Express/Node middleware/controllers, EJS/view conditionals) to fix every identified gap.

3. **Prioritized Action Plan**:
   - A step-by-step checklist of critical security fixes, database updates, and UI changes needed before project defense.