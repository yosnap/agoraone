-- The Central project a meeting was about (one of its client's projects), so what comes out of it (an issue
-- of GitHub, a task) goes to that project.
ALTER TABLE meeting ADD COLUMN project TEXT;
