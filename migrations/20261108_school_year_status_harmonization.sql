-- ============================================================================
-- MIGRATION: 20261108_school_year_status_harmonization.sql
-- Harmonize school_years.status enum to: 'Current', 'Draft', 'Archive'
-- ============================================================================

-- Step 1: Temporarily expand ENUM to contain both legacy and new values to prevent truncation
ALTER TABLE `school_years` 
MODIFY COLUMN `status` ENUM('Current', 'Draft', 'Archive', 'Active', 'Archived') NOT NULL DEFAULT 'Draft';

-- Step 2: Harmonize existing records
-- Active SY -> Current
UPDATE `school_years` 
SET `status` = 'Current' 
WHERE `is_active` = 1 OR `status` = 'Active';

-- Historical/Archived SY -> Archive
UPDATE `school_years` 
SET `status` = 'Archive' 
WHERE `status` = 'Archived' OR (`is_active` = 0 AND `status` != 'Draft' AND `status` != 'Current');

-- Step 3: Shrink ENUM to canonical 3 statuses: ('Current', 'Draft', 'Archive')
ALTER TABLE `school_years` 
MODIFY COLUMN `status` ENUM('Current', 'Draft', 'Archive') NOT NULL DEFAULT 'Draft';
