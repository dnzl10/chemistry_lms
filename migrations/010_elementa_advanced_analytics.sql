-- --------------------------------------------------------
-- Migration: 010_elementa_advanced_analytics.sql
-- Description: Indexes, schema extensions, kiosk monitoring, and analytical views
-- --------------------------------------------------------

-- 1. Extend elementa_game_sessions for gradebook sync tracking and cabinet identification
ALTER TABLE `elementa_game_sessions`
  ADD COLUMN IF NOT EXISTS `is_synced_to_gradebook` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `cabinet_id` VARCHAR(50) NOT NULL DEFAULT 'KIOSK-01';

-- 2. Extend elementa_customer_attempts for micro-telemetry analytics
ALTER TABLE `elementa_customer_attempts`
  ADD COLUMN IF NOT EXISTS `hesitation_score` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `scaffolding_used` VARCHAR(50) DEFAULT NULL;

-- 3. Add High-Performance Indexes for Aggregations and Analytics
ALTER TABLE `elementa_customer_attempts`
  ADD INDEX IF NOT EXISTS `idx_attempts_run_correct` (`run_id`, `is_correct`),
  ADD INDEX IF NOT EXISTS `idx_attempts_machine` (`machine_used`),
  ADD INDEX IF NOT EXISTS `idx_attempts_failure` (`failure_type`),
  ADD INDEX IF NOT EXISTS `idx_attempts_rt` (`response_time_s`);

ALTER TABLE `elementa_element_clicks`
  ADD INDEX IF NOT EXISTS `idx_clicks_symbol_run` (`element_symbol`, `run_id`),
  ADD INDEX IF NOT EXISTS `idx_clicks_player` (`player_number`, `click_source`);

ALTER TABLE `elementa_level_runs`
  ADD INDEX IF NOT EXISTS `idx_level_runs_session` (`session_id`, `level_number`, `run_status`);

-- 4. Kiosk / Cabinet Fleet Health Monitoring Table
CREATE TABLE IF NOT EXISTS `elementa_kiosk_status` (
  `kiosk_id` VARCHAR(50) NOT NULL,
  `ip_address` VARCHAR(45) NOT NULL,
  `status` ENUM('Online', 'Degraded', 'Offline') NOT NULL DEFAULT 'Online',
  `ping_ms` INT(11) NOT NULL DEFAULT 0,
  `active_session_id` INT(11) DEFAULT NULL,
  `scanner_status` ENUM('Connected', 'Disconnected', 'Unknown') NOT NULL DEFAULT 'Connected',
  `gpio_status` ENUM('Operational', 'Faulty', 'Simulated') NOT NULL DEFAULT 'Operational',
  `last_heartbeat` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`kiosk_id`),
  KEY `idx_kiosk_status` (`status`, `last_heartbeat`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Seed Default Local Kiosks
INSERT IGNORE INTO `elementa_kiosk_status` (`kiosk_id`, `ip_address`, `status`, `ping_ms`, `scanner_status`, `gpio_status`)
VALUES 
  ('KIOSK-LAB-01', '127.0.0.1', 'Online', 2, 'Connected', 'Operational'),
  ('KIOSK-LAB-02', '192.168.1.102', 'Online', 6, 'Connected', 'Operational');

-- 5. Analytical View: Student Competency & Bloom's Taxonomy Mastery
DROP VIEW IF EXISTS `v_elementa_competency_mastery`;
CREATE VIEW `v_elementa_competency_mastery` AS
SELECT 
  u.user_id,
  CONCAT(u.first_name, ' ', u.last_name) AS student_name,
  u.section,
  lr.level_number,
  lr.level_topic,
  COUNT(ca.attempt_id) AS total_attempts,
  SUM(ca.is_correct) AS correct_count,
  ROUND(SUM(ca.is_correct) / COUNT(ca.attempt_id) * 100, 2) AS raw_accuracy_pct,
  ROUND(AVG(ca.response_time_s), 2) AS avg_response_time_s,
  SUM(ca.is_timeout) AS total_timeouts,
  -- Latency-penalized mastery formula (decay factor on hesitation)
  ROUND(AVG(
    CASE 
      WHEN ca.is_correct = 1 AND ca.response_time_s <= 30 THEN 100
      WHEN ca.is_correct = 1 AND ca.response_time_s <= 60 THEN 85
      WHEN ca.is_correct = 1 THEN 70
      ELSE 0
    END
  ), 2) AS cognitive_mastery_index
FROM elementa_customer_attempts ca
JOIN elementa_level_runs lr ON lr.run_id = ca.run_id
JOIN elementa_game_sessions gs ON gs.session_id = lr.session_id
JOIN users u ON u.user_id = (CASE lr.player_number WHEN 1 THEN gs.student_id_p1 ELSE gs.student_id_p2 END)
WHERE u.user_id IS NOT NULL
GROUP BY u.user_id, lr.level_number, lr.level_topic;

-- 6. Analytical View: Question Difficulty & Psychometric Discrimination
DROP VIEW IF EXISTS `v_elementa_question_discrimination`;
CREATE VIEW `v_elementa_question_discrimination` AS
SELECT 
  ca.customer_id_ref,
  ca.level_number,
  ca.machine_used,
  ca.question_snapshot,
  COUNT(ca.attempt_id) AS total_attempts,
  SUM(ca.is_correct) AS total_correct,
  ROUND(SUM(ca.is_correct) / COUNT(ca.attempt_id), 2) AS difficulty_index_p,
  SUM(ca.is_timeout) AS total_timeouts,
  ROUND(AVG(ca.response_time_s), 2) AS avg_time_spent_s
FROM elementa_customer_attempts ca
WHERE ca.customer_id_ref IS NOT NULL
GROUP BY ca.customer_id_ref, ca.level_number, ca.machine_used, ca.question_snapshot;
