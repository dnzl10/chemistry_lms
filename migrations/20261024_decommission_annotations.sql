-- ============================================================================
-- MIGRATION: 20261024_decommission_annotations.sql
-- Purpose: Complete decommission of Student Queries & Annotations table.
-- Safe Archival: Backs up existing data to `_archived_annotations_backup`
--               before dropping `annotations`.
-- ============================================================================

-- 1. Create an archived backup snapshot of annotations (if table exists)
CREATE TABLE IF NOT EXISTS _archived_annotations_backup AS 
SELECT * FROM annotations;

-- 2. Drop the annotations table (removes all associated constraints & indexes)
DROP TABLE IF EXISTS annotations;
