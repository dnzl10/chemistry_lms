-- Phase 0: Foreign Key Hotfix on forum_topics.topic_id
-- Prevents cascade deletion of forum boards when a curriculum topic is removed.

ALTER TABLE `forum_topics` DROP FOREIGN KEY `fk_forum_topic`;

ALTER TABLE `forum_topics`
  MODIFY COLUMN `topic_id` INT(11) NULL DEFAULT NULL;

ALTER TABLE `forum_topics`
  ADD CONSTRAINT `fk_forum_topic`
    FOREIGN KEY (`topic_id`) REFERENCES `topics` (`topic_id`)
    ON DELETE SET NULL;
