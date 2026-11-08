-- Synthetic integrity smoke tests for 0001 + 0002.
-- Run ONLY against a disposable PostgreSQL database:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/0001_0002_integrity_smoke.sql
-- All inserted rows are rolled back. No production data is used.
BEGIN;

INSERT INTO users(firebase_uid) VALUES ('test-user-a'), ('test-user-b'), ('test-user-c');
INSERT INTO characters(firebase_uid, name, normalized_name)
VALUES ('test-user-a','Test A','test a'), ('test-user-b','Test B','test b'), ('test-user-c','Test C','test c');
INSERT INTO character_state(character_id, state)
SELECT id, '{"lvl":1,"inv":[]}'::jsonb FROM characters WHERE firebase_uid LIKE 'test-user-%';

INSERT INTO wallets(firebase_uid, premium_gold) VALUES ('test-user-a', 100), ('test-user-b', 0), ('test-user-c', 0);
INSERT INTO wallet_transactions(firebase_uid, operation, amount, idempotency_key)
VALUES ('test-user-a','test-credit',100,'smoke-test-wallet-a');

INSERT INTO reward_claims(firebase_uid, reward_type, source_id)
VALUES ('test-user-a','smoke','once-only');

INSERT INTO clans(id, name, normalized_name, leader_uid)
VALUES ('smoke-clan','Smoke Clan','smoke clan','test-user-a');
INSERT INTO clan_members(clan_id, firebase_uid, role)
VALUES ('smoke-clan','test-user-a','leader'), ('smoke-clan','test-user-b','member');

INSERT INTO friendships(id,user_a_uid,user_b_uid,status)
VALUES ('smoke-friendship','test-user-a','test-user-b','accepted');

INSERT INTO market_listings(id,seller_uid,item,price,status)
VALUES ('smoke-lot','test-user-a','{"id":"item-1"}',10,'active');

INSERT INTO raid_instances(id,status,round_number) VALUES ('smoke-raid','active',1);
INSERT INTO raid_participants(raid_id,firebase_uid) VALUES ('smoke-raid','test-user-a');
INSERT INTO raid_actions(raid_id,firebase_uid,round_number,action)
VALUES ('smoke-raid','test-user-a',1,'{"move":"strike"}');

INSERT INTO duel_instances(id,player_a_uid,player_b_uid,status)
VALUES ('smoke-duel','test-user-a','test-user-b','active');
INSERT INTO duel_actions(duel_id,round_number,actor_uid,action)
VALUES ('smoke-duel',1,'test-user-a','{"move":"guard"}');

INSERT INTO payments(xsolla_order_id,firebase_uid,status,gold_amount)
VALUES ('smoke-order','test-user-a','created',100);
INSERT INTO payment_orders(firebase_uid,xsolla_order_id,gold_amount)
VALUES ('test-user-a','smoke-order',100);

INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type)
VALUES ('00000000-0000-0000-0000-000000000001','character','test-user-a','smoke.created');
INSERT INTO notification_jobs(id,firebase_uid,kind,scheduled_at)
VALUES ('00000000-0000-0000-0000-000000000002','test-user-a','smoke',now());

DO $$
BEGIN
  -- Duplicate reward claim must be rejected.
  BEGIN
    INSERT INTO reward_claims(firebase_uid,reward_type,source_id)
    VALUES ('test-user-a','smoke','once-only');
    RAISE EXCEPTION 'expected duplicate reward claim to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Reverse-order duplicate friendship must be rejected by expression index.
  BEGIN
    INSERT INTO friendships(id,user_a_uid,user_b_uid,status)
    VALUES ('smoke-friendship-reverse','test-user-b','test-user-a','accepted');
    RAISE EXCEPTION 'expected reverse friendship duplicate to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Duplicate wallet idempotency key must be rejected.
  BEGIN
    INSERT INTO wallet_transactions(firebase_uid,operation,amount,idempotency_key)
    VALUES ('test-user-a','duplicate',-10,'smoke-test-wallet-a');
    RAISE EXCEPTION 'expected duplicate wallet key to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Negative wallet balance must be rejected.
  BEGIN
    UPDATE wallets SET premium_gold = -1 WHERE firebase_uid = 'test-user-a';
    RAISE EXCEPTION 'expected negative wallet balance to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
