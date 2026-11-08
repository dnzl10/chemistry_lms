-- DOWN MIGRATION: Revert assessments.sy_id addition
-- Target DB: chemistry_lms_staging

ALTER TABLE assessments 
DROP FOREIGN KEY fk_assessments_school_year;

DROP INDEX idx_assessments_sy_id ON assessments;

ALTER TABLE assessments 
DROP COLUMN sy_id;

