-- =====================================================================
-- Migration: Calendar Events Subsystem Upgrade
-- Date: 2026-10-14
-- Purpose: Support all event types, tenancy discriminator (creator_role),
--          section binding (class_id), and query performance indexes.
-- =====================================================================

-- 1. Modify event_type ENUM
ALTER TABLE `calendar_events` 
MODIFY COLUMN `event_type` ENUM('Material','Deadline','Exam','Holiday','Assignment','Arcade Session') NOT NULL DEFAULT 'Material';

-- 2. Add creator_role column
ALTER TABLE `calendar_events` 
ADD COLUMN `creator_role` ENUM('Student','Teacher','Admin') NOT NULL DEFAULT 'Teacher' AFTER `teacher_id`;

-- 3. Backfill creator_role based on users.role
UPDATE `calendar_events` ce
JOIN `users` u ON ce.teacher_id = u.user_id
SET ce.creator_role = u.role;

-- 4. Add class_id column
ALTER TABLE `calendar_events` 
ADD COLUMN `class_id` INT(11) NULL DEFAULT NULL AFTER `subject_id`;

-- 5. Add performance indexes
ALTER TABLE `calendar_events` 
ADD KEY `idx_cal_creator_date` (`teacher_id`, `event_date`),
ADD KEY `idx_cal_subject_date` (`subject_id`, `event_date`);
