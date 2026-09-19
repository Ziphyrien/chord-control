CREATE TABLE devices (
  id TEXT PRIMARY KEY, public_key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  trusted INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  sequence INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX devices_last_seen ON devices(last_seen);
CREATE TABLE reports (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(device_id, sequence)
);
CREATE INDEX reports_received ON reports(received_at);
