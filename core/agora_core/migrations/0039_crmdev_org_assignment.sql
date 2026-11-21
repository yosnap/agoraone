-- The organization of CRMDev each client or project of Central belongs to, when the user chose it (one per record).
-- A record linked with one of an organization's records belongs to that one whatever is kept here: the link wins.
-- Only ids: `central_id` is Central's own id and `org` the id AgoraOne gave the organization (`o1`, `o2`…). Times UTC.

CREATE TABLE crmdev_org_assignment (
  kind TEXT NOT NULL CHECK (kind IN ('client', 'project')),
  central_id TEXT NOT NULL CHECK (length(central_id) BETWEEN 1 AND 100),
  org TEXT NOT NULL CHECK (length(org) BETWEEN 2 AND 5),
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, central_id)
);
