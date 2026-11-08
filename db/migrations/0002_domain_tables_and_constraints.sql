-- Northfall Phase 3 additive domain tables and integrity constraints.
-- DRAFT ONLY. Apply only to a disposable PostgreSQL database after review.
-- Requires 0001_initial_hybrid_schema.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS account_private (
  firebase_uid TEXT PRIMARY KEY REFERENCES users(firebase_uid) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  private_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(settings) = 'object'),
  CHECK (jsonb_typeof(private_data) = 'object')
);

CREATE TABLE IF NOT EXISTS duel_instances (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'waiting',
  player_a_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  player_b_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  round_number BIGINT NOT NULL DEFAULT 0 CHECK (round_number >= 0),
  current_turn_uid TEXT REFERENCES users(firebase_uid),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (player_a_uid <> player_b_uid),
  CHECK (jsonb_typeof(state) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_duels_status_updated ON duel_instances(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS duel_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  duel_id TEXT NOT NULL REFERENCES duel_instances(id) ON DELETE CASCADE,
  round_number BIGINT NOT NULL CHECK (round_number >= 0),
  actor_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  action JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (duel_id, round_number, actor_uid)
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  invited_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','eligible','paid','rejected')),
  referrer_amount BIGINT NOT NULL DEFAULT 0 CHECK (referrer_amount >= 0),
  invited_amount BIGINT NOT NULL DEFAULT 0 CHECK (invited_amount >= 0),
  eligible_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referrer_uid <> invited_uid),
  UNIQUE (referrer_uid, invited_uid)
);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_invited ON referral_rewards(invited_uid, status);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT REFERENCES users(firebase_uid),
  kind TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT REFERENCES users(firebase_uid)
);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_recent ON fraud_flags(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_user_recent ON fraud_flags(firebase_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version BIGINT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(created_at, id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY,
  firebase_uid TEXT REFERENCES users(firebase_uid),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due ON notification_jobs(scheduled_at, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_uid TEXT REFERENCES users(firebase_uid),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_recent ON admin_audit(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  stat_date DATE NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT '',
  value BIGINT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stat_date, metric, dimension)
);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Do not store API keys, webhook secrets, VAPID private keys or credentials here.

CREATE TABLE IF NOT EXISTS clan_dungeon_state (
  clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  cycle_key TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, cycle_key)
);

CREATE TABLE IF NOT EXISTS raid_queue (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  queue_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','matched','cancelled','expired')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raid_queue_waiting ON raid_queue(queue_type, created_at, id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_raid_queue_expiry ON raid_queue(expires_at) WHERE status IN ('waiting','matched');

CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  room_type TEXT NOT NULL DEFAULT 'public',
  title TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_room_members (
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, firebase_uid)
);
CREATE INDEX IF NOT EXISTS idx_chat_room_members_user ON chat_room_members(firebase_uid, room_id);

CREATE TABLE IF NOT EXISTS message_claims (
  message_id TEXT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  claimant_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, claimant_uid)
);

-- A friendship is an unordered pair. This prevents A-B and B-A duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_friendships_unordered_pair
  ON friendships (LEAST(user_a_uid, user_b_uid), GREATEST(user_a_uid, user_b_uid));

CREATE INDEX IF NOT EXISTS idx_payments_user_recent
  ON payments(firebase_uid, created_at DESC, xsolla_order_id DESC);

CREATE INDEX IF NOT EXISTS idx_profiles_rating_tiebreak
  ON player_profiles(rating DESC NULLS LAST, firebase_uid);
CREATE INDEX IF NOT EXISTS idx_profiles_level_tiebreak
  ON player_profiles(level DESC NULLS LAST, firebase_uid);
CREATE INDEX IF NOT EXISTS idx_profiles_stats_tiebreak
  ON player_profiles(stat_sum DESC NULLS LAST, firebase_uid);

CREATE INDEX IF NOT EXISTS idx_market_active_cursor
  ON market_listings(created_at DESC, id DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_dm_pair_cursor
  ON direct_messages(pair_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_cursor
  ON chat_messages(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_forum_posts_cursor
  ON forum_posts(topic_id, created_at ASC, id ASC);

COMMIT;
