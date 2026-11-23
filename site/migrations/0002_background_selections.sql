CREATE TABLE IF NOT EXISTS background_selections (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('previous', 'delivered')),
  source TEXT NOT NULL,
  by_name TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS background_selections_item ON background_selections (id, seq);
