-- ============================================================================
-- Migration: Forum View Enhancements & Student Threading
-- Target Schema: Elementa Chemistry LMS (`chemistry_arcade_lms`)
-- ============================================================================

-- 1. Add reply_title to forum_replies for root student discussion topics
-- Note: Handled idempotently in the migration runner if column exists
ALTER TABLE `forum_replies`
  ADD COLUMN `reply_title` VARCHAR(255) NULL AFTER `parent_reply_id`;

-- 2. Performance index for root topics and threaded hierarchy lookups
ALTER TABLE `forum_replies`
  ADD KEY `idx_parent_topic` (`topic_id`, `parent_reply_id`);

-- 3. Personal Starred Discussions (Per-Student Bookmark)
CREATE TABLE IF NOT EXISTS `forum_reply_stars` (
  `star_id`     INT(11) NOT NULL AUTO_INCREMENT,
  `user_id`     INT(11) NOT NULL,
  `reply_id`    INT(11) NOT NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`star_id`),
  UNIQUE KEY `uq_user_reply_star` (`user_id`, `reply_id`),
  KEY `fk_star_reply` (`reply_id`),
  CONSTRAINT `fk_star_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_star_reply` FOREIGN KEY (`reply_id`) REFERENCES `forum_replies` (`reply_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. Personal Hidden Discussions ("Hide for Me")
CREATE TABLE IF NOT EXISTS `forum_reply_hidden` (
  `hide_id`     INT(11) NOT NULL AUTO_INCREMENT,
  `user_id`     INT(11) NOT NULL,
  `reply_id`    INT(11) NOT NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`hide_id`),
  UNIQUE KEY `uq_user_reply_hide` (`user_id`, `reply_id`),
  KEY `fk_hide_reply` (`reply_id`),
  CONSTRAINT `fk_hide_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hide_reply` FOREIGN KEY (`reply_id`) REFERENCES `forum_replies` (`reply_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 5. Discussion & Reply Moderation Reports
CREATE TABLE IF NOT EXISTS `forum_reports` (
  `report_id`   INT(11) NOT NULL AUTO_INCREMENT,
  `reporter_id` INT(11) NOT NULL,
  `reply_id`    INT(11) NOT NULL,
  `reason`      VARCHAR(100) NOT NULL,
  `details`     TEXT NULL,
  `status`      ENUM('pending', 'reviewed', 'dismissed', 'actioned') NOT NULL DEFAULT 'pending',
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`report_id`),
  KEY `fk_report_reply` (`reply_id`),
  KEY `fk_report_user` (`reporter_id`),
  CONSTRAINT `fk_report_user` FOREIGN KEY (`reporter_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_report_reply` FOREIGN KEY (`reply_id`) REFERENCES `forum_replies` (`reply_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
