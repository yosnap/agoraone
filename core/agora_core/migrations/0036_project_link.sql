-- Links between one of Central's projects and one of CRMDev's that the user made («Enlazar») or said are different
-- («Son distintos»). Only added: a project with the same name on both sides is paired without being stored here.
-- Each project has one `linked` with the other side at most. Nothing is copied from a connector nor deleted when it
-- goes away: its projects just stop showing. Times UTC.

CREATE TABLE project_link (
  central_id TEXT NOT NULL CHECK (length(central_id) BETWEEN 1 AND 64),
  crmdev_id TEXT NOT NULL CHECK (length(crmdev_id) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN ('linked', 'distinct')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (central_id, crmdev_id)
);
CREATE UNIQUE INDEX project_link_one_central ON project_link (central_id) WHERE state = 'linked';
CREATE UNIQUE INDEX project_link_one_crmdev ON project_link (crmdev_id) WHERE state = 'linked';
