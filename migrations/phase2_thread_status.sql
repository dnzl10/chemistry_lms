-- Phase 2: Thread Status Tracking
-- Adds status enum, resolved_by FK, and status index to forum_topics

ALTER TABLE `forum_topics`
  ADD COLUMN `status` ENUM('unresolved', 'solved', 'instructor_verified') NOT NULL DEFAULT 'unresolved' AFTER `is_pinned`,
  ADD COLUMN `resolved_by` INT(11) DEFAULT NULL AFTER `status`,
  ADD KEY `idx_forum_status` (`status`),
  ADD CONSTRAINT `fk_forum_resolved_by`
    FOREIGN KEY (`resolved_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL;
