-- Phase 3: Instructor-Endorsed & Accepted Answer Schema
-- Adds is_endorsed, is_accepted, and is_locked to forum_replies

ALTER TABLE `forum_replies`
  ADD COLUMN `is_endorsed` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_anonymous`,
  ADD COLUMN `is_accepted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_endorsed`,
  ADD COLUMN `is_locked`   TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_accepted`;
