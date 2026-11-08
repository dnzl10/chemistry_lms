-- ============================================================================
-- MIGRATION: 20261108_add_sy_id_to_assessments.sql
-- Add sy_id column and foreign key constraint to assessments table
-- Target DB: chemistry_lms_staging
-- ============================================================================

-- 1. Add sy_id column to assessments (after assessment_id)
ALTER TABLE `assessments` 
ADD COLUMN `sy_id` INT NULL AFTER `assessment_id`;

-- 2. Add Foreign Key to school_years
ALTER TABLE `assessments` 
ADD CONSTRAINT `fk_assessments_school_year` 
FOREIGN KEY (`sy_id`) REFERENCES `school_years`(`sy_id`) 
ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Backfill existing assessments to the active Current School Year
UPDATE `assessments` 
SET `sy_id` = (SELECT `sy_id` FROM `school_years` WHERE `is_active` = 1 LIMIT 1) 
WHERE `sy_id` IS NULL;

-- 4. Add index for query performance
CREATE INDEX `idx_assessments_sy_id` ON `assessments`(`sy_id`);
