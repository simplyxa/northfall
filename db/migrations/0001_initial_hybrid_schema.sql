-- Northfall PostgreSQL schema — Phase 3 draft
-- NOT FOR PRODUCTION CUTOVER until validated against a real Firestore export.
-- PostgreSQL 15+. Firebase Auth remains the identity provider.
-- This schema is additive and intentionally preserves evolving game payloads in JSONB.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  firebase_uid TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firebase_uid TEXT NOT NULL UNIQUE REFERENCES users(firebase_uid),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  clan_id TEXT,
  source_document_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_characters_level ON characters(level DESC, id);
CREATE INDEX IF NOT EXISTS idx_characters_clan ON characters(clan_id) WHERE clan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS character_state (
  character_id BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  save_version BIGINT NOT NULL DEFAULT 1 CHECK (save_version >= 1),
  source_document_id TEXT,
  source_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(state) = 'object')
);

CREATE TABLE IF NOT EXISTS player_profiles (
  firebase_uid TEXT PRIMARY KEY REFERENCES users(firebase_uid) ON DELETE CASCADE,
  level INTEGER,
  stat_sum BIGINT,
  rating BIGINT,
  season_rating BIGINT,
  wins BIGINT,
  losses BIGINT,
  duel_rating BIGINT,
  duel_count BIGINT,
  duel_wins BIGINT,
  season_id BIGINT,
  previous_season_id BIGINT,
  previous_season_rating BIGINT,
  clan_war_points BIGINT,
  seen_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_level ON player_profiles(level DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_profiles_rating ON player_profiles(rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_profiles_season_rating ON player_profiles(season_rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_profiles_stat_sum ON player_profiles(stat_sum DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS wallets (
  firebase_uid TEXT PRIMARY KEY REFERENCES users(firebase_uid) ON DELETE CASCADE,
  premium_gold BIGINT NOT NULL DEFAULT 0 CHECK (premium_gold >= 0),
  exchange_day TEXT,
  exchange_amount BIGINT NOT NULL DEFAULT 0 CHECK (exchange_amount >= 0),
  boss_claim_day TEXT,
  boss_claim_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  reward_markers JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_gifts JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  operation TEXT NOT NULL,
  amount BIGINT NOT NULL,
  reason TEXT,
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_time
  ON wallet_transactions(firebase_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS reward_claims (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  reward_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  amount BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(firebase_uid, reward_type, source_id)
);

CREATE TABLE IF NOT EXISTS clans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  leader_uid TEXT REFERENCES users(firebase_uid),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  experience BIGINT NOT NULL DEFAULT 0,
  treasury JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clans_name_normalized ON clans(lower(name));

CREATE TABLE IF NOT EXISTS clan_members (
  clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  member_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  joined_at TIMESTAMPTZ,
  PRIMARY KEY (clan_id, firebase_uid),
  UNIQUE (firebase_uid)
);
CREATE INDEX IF NOT EXISTS idx_clan_members_clan_role ON clan_members(clan_id, role);

CREATE TABLE IF NOT EXISTS clan_contributions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  gold BIGINT NOT NULL DEFAULT 0 CHECK (gold >= 0),
  iron BIGINT NOT NULL DEFAULT 0 CHECK (iron >= 0),
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clan_id, firebase_uid)
);

CREATE TABLE IF NOT EXISTS clan_activity (
  id TEXT PRIMARY KEY,
  clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  actor_uid TEXT REFERENCES users(firebase_uid),
  event_type TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clan_activity_time ON clan_activity(clan_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_listings (
  id TEXT PRIMARY KEY,
  seller_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  buyer_uid TEXT REFERENCES users(firebase_uid),
  seller_name TEXT,
  buyer_name TEXT,
  item JSONB NOT NULL,
  price BIGINT NOT NULL CHECK (price > 0),
  currency TEXT NOT NULL DEFAULT 'premium_gold',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled','expired')),
  legacy_au BOOLEAN,
  legacy_srv INTEGER,
  source_document_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_market_active_created ON market_listings(created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_market_active_price ON market_listings(price ASC, created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_market_seller_status ON market_listings(seller_uid, status, created_at DESC);

CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  sender_uid TEXT REFERENCES users(firebase_uid),
  sender_name TEXT,
  body TEXT,
  item JSONB,
  item_claimed BOOLEAN NOT NULL DEFAULT false,
  item_claimed_at TIMESTAMPTZ,
  paid_marker BIGINT NOT NULL DEFAULT 0,
  server_created BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_dm_pair_time ON direct_messages(pair_id, created_at DESC);

CREATE TABLE IF NOT EXISTS raid_instances (
  id TEXT PRIMARY KEY,
  raid_type TEXT,
  status TEXT,
  round_number BIGINT,
  deadline_ms BIGINT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_raids_status_updated ON raid_instances(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS raid_participants (
  raid_id TEXT NOT NULL REFERENCES raid_instances(id) ON DELETE CASCADE,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  participant_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (raid_id, firebase_uid)
);

CREATE TABLE IF NOT EXISTS raid_actions (
  raid_id TEXT NOT NULL REFERENCES raid_instances(id) ON DELETE CASCADE,
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  round_number BIGINT NOT NULL,
  action JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (raid_id, firebase_uid, round_number)
);

CREATE TABLE IF NOT EXISTS clan_wars (
  id TEXT PRIMARY KEY,
  clan_a_id TEXT REFERENCES clans(id),
  clan_b_id TEXT REFERENCES clans(id),
  ends_at_ms BIGINT,
  started_at_ms BIGINT,
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_clan_wars_active_end ON clan_wars(ends_at_ms) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS world_events (
  id TEXT PRIMARY KEY,
  event_day BIGINT,
  event_type TEXT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_world_events_day ON world_events(event_day DESC);

CREATE TABLE IF NOT EXISTS territories (
  id TEXT PRIMARY KEY,
  owner_clan_id TEXT REFERENCES clans(id),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  xsolla_order_id TEXT PRIMARY KEY,
  firebase_uid TEXT REFERENCES users(firebase_uid),
  status TEXT NOT NULL,
  gold_amount BIGINT,
  base_amount BIGINT,
  promo_multiplier NUMERIC(6,3),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  payment_amount NUMERIC(14,2),
  payment_currency TEXT,
  payment_mode TEXT,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_orders (
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  xsolla_order_id TEXT NOT NULL REFERENCES payments(xsolla_order_id),
  gold_amount BIGINT,
  base_balance BIGINT,
  promo_multiplier NUMERIC(6,3),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  claimed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (firebase_uid, xsolla_order_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  user_a_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  user_b_uid TEXT NOT NULL REFERENCES users(firebase_uid),
  status TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_a_uid <> user_b_uid)
);
CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a_uid, status);
CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b_uid, status);

CREATE TABLE IF NOT EXISTS forum_topics (
  id TEXT PRIMARY KEY,
  author_uid TEXT REFERENCES users(firebase_uid),
  title TEXT,
  topic_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
  author_uid TEXT REFERENCES users(firebase_uid),
  body TEXT,
  post_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forum_posts_topic_time ON forum_posts(topic_id, created_at ASC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  author_uid TEXT REFERENCES users(firebase_uid),
  author_name TEXT,
  body TEXT,
  message_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_time ON chat_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT REFERENCES users(firebase_uid),
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migration_source_documents (
  source_path TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_update_time TIMESTAMPTZ,
  payload JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_path, source_document_id)
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dry_run','validated','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  report JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
