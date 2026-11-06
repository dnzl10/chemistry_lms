Act as a Senior Full-Stack Architect and LMS Product Specialist. 

I need an in-depth audit of the notification system in my Learning Management System (LMS), specifically focusing on the in-app Notification Modal/Panel. 

The goal is to ensure our notification panel serves as a centralized, effective activity hub, routing every critical alert, reminder, and system event to the right users.

Please review my codebase, database schemas, and current notification logic to perform a comprehensive Gap Analysis broken down by our three core user roles: Student, Teacher, and Admin.

### Context to Analyze:
[Paste your relevant code, database schema, event triggers, or context here—e.g., notification components, event listeners, backend controllers, user models]

---

### Deliverables Required:

1. **Current State Audit (Implemented Notifications)**
   - Identify every notification type, event, or trigger currently routed to the Notification Modal.
   - Map them to the specific role that receives them:
     - **Student**
     - **Teacher**
     - **Admin**
   - Note how they are currently delivered (e.g., read/unread state tracking, real-time via WebSockets/polling, persistent vs. toast/pop-up only).

2. **Gap Analysis (Missing & "Must-Have" Notifications)**
   - Identify system events, updates, or critical workflows that are currently *not* sent to the notification panel (e.g., events currently lost in email, only shown as temporary banners/toasts, or missing entirely).
   - Detail the **Must-Have** and **Recommended** notification types for each role:
     - **Student:** (e.g., grade releases, submission receipts, overdue warnings, upcoming deadlines, class announcements, enrollment confirmations).
     - **Teacher:** (e.g., new submissions, late submissions, enrollment requests, student inactivity flags, system grading alerts).
     - **Admin:** (e.g., user account approvals, critical error/crash reports, course approval requests, subscription/payment alerts, bulk-import completions).

3. **Role-Based Comparison Matrix**
   - Provide a consolidated Markdown table with the following columns:
     - `Role`
     - `Notification Event / Trigger`
     - `Current Status (Implemented / Missing / Incomplete)`
     - `Priority (Critical / High / Medium)`
     - `Trigger Event (e.g., onAssignmentGraded, onUserRegistered)`
     - `Target Action / Deep Link (Where the modal click should redirect)`

4. **Technical & Architectural Recommendations**
   - Highlight any anti-patterns in the current implementation (e.g., missing database indexes, lack of read/unread flags, absent deep-link routing, or performance bottlenecks with real-time delivery).
   - Suggest schema additions or clean event-driven patterns (e.g., observer/publish-subscribe pattern) needed to implement the missing notifications cleanly.

Be rigorous and identify any edge cases or critical alerts that an industry-standard LMS must have in its notification center.