-- Phase 1: Anonymous Posting Mode & Audit Log Schema
-- Adds is_anonymous column to forum_replies and creates forum_unmask_logs table

ALTER TABLE `forum_replies`
  ADD COLUMN `is_anonymous` TINYINT(1) NOT NULL DEFAULT 0
  AFTER `user_id`;

CREATE TABLE IF NOT EXISTS `forum_unmask_logs` (
  `log_id`          INT(11)       NOT NULL AUTO_INCREMENT,
  `unmasker_id`     INT(11)       NOT NULL,
  `unmasker_role`   VARCHAR(20)   NOT NULL,
  `target_reply_id` INT(11)       NOT NULL,
  `justification`   TEXT          NOT NULL,
  `created_at`      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`log_id`),
  KEY `idx_target_reply` (`target_reply_id`),
  CONSTRAINT `fk_unmask_reply` FOREIGN KEY (`target_reply_id`)
    REFERENCES `forum_replies` (`reply_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_unmask_user` FOREIGN KEY (`unmasker_id`)
    REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
