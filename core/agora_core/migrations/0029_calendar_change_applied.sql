-- Whether a kept change really reached the calendar: the copy is written first, and marked applied only once macOS
-- saved the change, so the record never says an event became something it did not.
ALTER TABLE calendar_change ADD COLUMN applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1));
