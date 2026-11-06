# Comprehensive System Audit: Announcement & Broadcast Architecture

### Role & Objective
Act as a Principal Full-Stack Software Architect and Lead QA Engineer. Your task is to perform an exhaustive, evidence-based audit of the current codebase, database schemas, and UI components to determine the exact implementation status of our redesigned Announcement & Broadcast System.

Do not make assumptions or extrapolate. You must verify whether each feature exists in the current system, partially exists, or is missing entirely. If a feature is not implemented, identify the closest existing implementation or foundation currently in place (e.g., standard CRUD, basic alerts, generic notification tables).

---

## 1. Feature-by-Feature Gap Analysis

Inspect and audit the following 5 target features:

### Feature 1: "Micro-Comprehension Check" (One-Click React & Accountability)
* **Target Spec:** 
  * Replaces automated/high-write read receipts.
  * In-app acknowledgment buttons on announcements: `[Understood]` vs. `[Needs Clarification]` / optional 1-click confirmation.
  * Teacher/Admin view: Aggregated percentage/count breakdown (e.g., "88% understood, 5 flagged questions").
  * Low-write persistence (e.g., dedicated acknowledgment table recording discrete user clicks).
* **Audit Questions:**
  1. Does any database table track discrete user acknowledgment states (e.g., `announcement_acks`, `reactions`, etc.)?
  2. Does the frontend render acknowledgment action buttons, and do corresponding API endpoints process these states?
  3. Does an analytics or progress summary view exist for instructors/admins to monitor these metrics?
  4. *If not implemented:* What is the current read/tracking mechanism (e.g., silent view logs, simple boolean flags, or no tracking at all)?

### Feature 2: "Critical Intercept Modal" (Emergency Gating with Read-Timer)
* **Target Spec:** 
  * Replaces invasive top tickers and permanent sticky floating banners.
  * Non-intrusive, one-time gating modal triggered only for critical/emergency announcements upon login or course entry.
  * Hard read-timer on the dismiss/acknowledge button (3–5 second countdown before enabling interaction).
  * Session-based persistence: Once acknowledged, it does not prompt again within the same session.
* **Audit Questions:**
  1. Is there an `is_critical`, `priority`, or emergency flag in the announcement data model?
  2. Does a client-side intercept modal component exist with an enforced JavaScript countdown timer?
  3. How is the dismissed state tracked (e.g., `localStorage`, session storage, or user profile log)?
  4. *If not implemented:* How are urgent/critical announcements currently presented (e.g., standard alerts, basic banners, or flash messages)?

### Feature 3: "Direct-to-Community" Webhook Dispatch (Zero-Queue External Blasting)
* **Target Spec:** 
  * Replaces heavy asynchronous email/SMS queue engines (Redis/BullMQ/workers).
  * Checkbox or toggle on the announcement publishing form: "Forward to Discord/Telegram".
  * Synchronous or lightweight HTTP POST dispatch to a configured webhook endpoint with formatted payloads.
* **Audit Questions:**
  1. Are there fields or models storing webhook URLs (course-level or campus-level)?
  2. Does the announcement creation controller/route contain external HTTP dispatch logic (e.g., `fetch` / `axios` calls to Discord/Telegram APIs)?
  3. *If not implemented:* What outbound notification channels currently exist (e.g., Nodemailer, SMTP, 3rd-party push, or strictly in-app notifications)?

### Feature 4: "Smart Deadline Badge & Countdown Card"
* **Target Spec:** 
  * Optional `Action Required Date` / `due_date` field in the announcement form.
  * Dynamic visual countdown pill/card on the client (e.g., `[ ⏳ 2 Days Left ] • Due: Sept 8, 11:59 PM`).
  * Direct "Add to Google Calendar" link generator (`https://calendar.google.com/calendar/render?...`) without OAuth or third-party API dependencies.
* **Audit Questions:**
  1. Does the announcement schema support a deadline or action-required timestamp distinct from publication/expiration dates?
  2. Does the frontend calculate and display a real-time countdown badge?
  3. Is there calendar export logic or pre-formatted Google Calendar link generation in the template/view?
  4. *If not implemented:* How are dates and deadlines inside announcements currently structured and displayed?

### Feature 5: "Focus Mode" & Custom Notification Sound Packs
* **Target Spec:** 
  * Client-side audio feedback: Sound theme selector (e.g., Soft Chime, Modern Pop, Mute) leveraging the HTML5 `Audio()` API.
  * "Focus Mode" toggle switch: Hides unread badges, counters, and suppresses audio cues without altering backend database records.
  * State persisted locally via `localStorage`.
* **Audit Questions:**
  1. Are there audio assets or HTML5 Audio initialization logic linked to incoming notifications?
  2. Is there a "Focus Mode" state handler that toggles notification visibility or mute behaviors on the frontend?
  3. *If not implemented:* What client-side controls or user preferences currently exist for notifications?

---

## 2. Role-Based Access Control (RBAC) & Capabilities Audit

Audit the codebase to verify whether the following capabilities and permission boundaries are enforced for **Admin**, **Teacher**, and **Student**:

### Admin (System Administrator)
* [ ] Can publish System-Wide / Global Broadcasts affecting all courses and departments.
* [ ] Has exclusive authority to trigger the System-Level Critical Intercept Modal.
* [ ] Can post, attach rich-text/files, and dispatch webhooks across any course.
* [ ] Can view aggregated Micro-Comprehension metrics and compliance logs.
* [ ] Can moderate/override announcement comment threads.

### Teacher (Instructor)
* [ ] Can publish, edit, schedule, and attach media to announcements strictly within assigned courses/sections.
* [ ] Can toggle comments/replies (discussion vs. read-only) on their course posts.
* [ ] Can trigger Course-Level Critical Intercept Modals for their enrolled students.
* [ ] Can set an Action Required Date (countdown badge) and trigger the Discord/Telegram webhook dispatch.
* [ ] Has access to a real-time breakdown of student Micro-Comprehension responses.

### Student (Learner)
* [ ] Restricted to read-only access (cannot author course or global announcements).
* [ ] Can submit Micro-Comprehension responses (`Understood` / `Needs Clarification`).
* [ ] Required to acknowledge Critical Intercept Modals with the enforced countdown timer.
* [ ] Can reply/comment only when `allow_replies` is enabled.
* [ ] Can click to export deadlines to Google Calendar.
* [ ] Has local UI controls for Focus Mode and notification sound selection.

---

## 3. Required Output Format

Provide your evaluation using the following structured format:

1. **Executive Status Summary:** A concise score or matrix showing each feature's status: `[ Fully Implemented | Partially Implemented | Missing / Legacy Only ]`.
2. **Detailed Feature Verification:** For each of the 5 features:
   * Current Status in Codebase.
   * File references, schemas, or components where existing or partial logic resides.
   * What is currently existing if the feature is missing (the gap between current code and target spec).
3. **RBAC & Permissions Assessment:** Verification of role boundaries across Admin, Teacher, and Student roles with specific middleware/permission checks referenced.
4. **Concrete Action Plan:** Step-by-step technical recommendations (schema migrations, API route additions, and UI components) required to bridge the remaining gaps.