-- Phase 4: Student Leaderboard Ghost Mode (Privacy Masking)
-- Adds persistent ghost mode preference, anonymous codename, and ghost avatar to users table

ALTER TABLE `users`
  ADD COLUMN `is_ghost_mode` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_ready_for_arcade`,
  ADD COLUMN `ghost_name` VARCHAR(100) DEFAULT NULL AFTER `is_ghost_mode`,
  ADD COLUMN `ghost_avatar` VARCHAR(255) DEFAULT 'ghost_avatar_1.png' AFTER `ghost_name`;
