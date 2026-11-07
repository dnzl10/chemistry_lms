-- DOWN MIGRATION: 20261108_sy_status_harmonization.down.sql
-- Restores status column enum back to ('Draft', 'Active', 'Archived')

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE `school_years` 
MODIFY COLUMN `status` ENUM('Draft', 'Active', 'Archived') NOT NULL DEFAULT 'Draft';

UPDATE `school_years` 
SET `status` = 'Active' 
WHERE `is_active` = 1;

UPDATE `school_years` 
SET `status` = 'Archived' 
WHERE `status` = 'Archive';

SET FOREIGN_KEY_CHECKS = 1;

