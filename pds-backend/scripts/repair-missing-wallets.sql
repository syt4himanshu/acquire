-- Repair: create the missing monthly wallet for ration cards that have none.
--
-- Affects only ration_cards that have NO wallets row. Existing wallets are not
-- read, updated or reset. The balances written are the card's policy allocation
-- (policies.rice_per_card_grams / wheat_per_card_grams, converted to kg), the
-- same values createRationCard and bulkCreateRationCards write.
--
-- Usage (dev database, dry run first):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/repair-missing-wallets.sql
--
-- The file runs in a transaction and ENDS WITH ROLLBACK, so the default run is a
-- preview. To apply the change, change the final ROLLBACK to COMMIT and run it
-- again. Re-running after a COMMIT is safe: the INSERT only targets cards that
-- still have no wallet, and ration_card_id is unique.

BEGIN;

-- 1. Preview: which cards are missing a wallet, and what would be created.
SELECT rc.card_number,
       rc.category,
       rc.created_at,
       p.rice_per_card_grams / 1000.0  AS rice_kg,
       p.wheat_per_card_grams / 1000.0 AS wheat_kg
FROM ration_cards rc
JOIN policies p ON p.category = rc.category
WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.ration_card_id = rc.id)
ORDER BY rc.created_at;

-- 2. Create the missing wallets.
INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg)
SELECT rc.id,
       p.rice_per_card_grams / 1000.0,
       p.wheat_per_card_grams / 1000.0
FROM ration_cards rc
JOIN policies p ON p.category = rc.category
WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.ration_card_id = rc.id)
ON CONFLICT (ration_card_id) DO NOTHING;

-- 3. Verify: every card should now have exactly one wallet. Expect 0.
SELECT COUNT(*) AS cards_still_without_wallet
FROM ration_cards rc
WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.ration_card_id = rc.id);

ROLLBACK;  -- change to COMMIT to apply
