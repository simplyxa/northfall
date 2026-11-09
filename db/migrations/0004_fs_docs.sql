-- Northfall Phase 6: документное хранилище, совместимое по интерфейсу с Firestore (server/pgdocs.js).
-- Все серверные модули ходят в базу через admin.firestore(); при STORE=pg этот вызов отдаёт слой
-- поверх этой таблицы. Реляционные таблицы 0001-0003 остаются для постепенного выноса горячих данных.
BEGIN;
CREATE TABLE IF NOT EXISTS fs_docs (
  path        TEXT PRIMARY KEY,                 -- 'saves/uid', 'wallet/uid/log/abc'
  parent      TEXT NOT NULL,                    -- путь коллекции: 'saves', 'wallet/uid/log'
  coll        TEXT NOT NULL,                    -- имя коллекции (последний сегмент) — для collectionGroup
  id          TEXT NOT NULL,
  data        JSONB NOT NULL,
  create_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  update_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_fs_docs_parent ON fs_docs(parent, id);
CREATE INDEX IF NOT EXISTS idx_fs_docs_coll ON fs_docs(coll);
COMMIT;
