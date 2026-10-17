# PDS Database Schema Documentation

## Overview
This document describes the complete database schema for the Public Distribution System (PDS), including core beneficiary management, IoT-enabled dispensing, blockchain integration, and anomaly detection.

---

## Core Tables

### `areas`
Geographic/administrative regions for organizing shops and ration cards.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| name | varchar(100) | NOT NULL, UNIQUE | Area name |
| is_active | boolean | NOT NULL, DEFAULT true | Whether area is active (added in migration 004) |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Indexes:**
- Primary key on `id`

---

### `policies`
Entitlement rules per ration card category.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| category | ration_category | NOT NULL, UNIQUE | APL, BPL, or AAY |
| rice_per_person_kg | numeric(5,2) | NOT NULL, DEFAULT 0 | Rice allocation per person (kg) |
| wheat_per_person_kg | numeric(5,2) | NOT NULL, DEFAULT 0 | Wheat allocation per person (kg) |
| sugar_per_person_kg | numeric(5,2) | NOT NULL, DEFAULT 0 | Sugar allocation per person (kg) |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Enum Types:**
- `ration_category`: 'APL', 'BPL', 'AAY'

**Seeded Data:**
- APL: 3kg rice, 2kg wheat, 0.5kg sugar
- BPL: 5kg rice, 3kg wheat, 1kg sugar
- AAY: 7kg rice, 8kg wheat, 1kg sugar

---

### `users`
All system users (admins, shopkeepers, beneficiaries).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| role | user_role | NOT NULL | User role |
| name | varchar(150) | | User's full name |
| email | varchar(255) | UNIQUE | Email address |
| mobile | varchar(15) | UNIQUE | Mobile number |
| password_hash | text | | Bcrypt hashed password |
| is_active | boolean | NOT NULL, DEFAULT true | Whether user is active |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Enum Types:**
- `user_role`: 'admin', 'shopkeeper', 'beneficiary'

**Seeded Data:**
- Admin user: email `admin@pds.gov`, password `admin123` (hashed)

---

### `shops`
Fair price shops (ration shops).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| shop_code | varchar(20) | NOT NULL, UNIQUE | Shop code |
| shop_name | varchar(150) | NOT NULL | Shop name |
| area_id | uuid | NOT NULL, REFERENCES areas | Area where shop is located |
| shopkeeper_id | uuid | REFERENCES users, ON DELETE SET NULL | Assigned shopkeeper |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Indexes:**
- `area_id`
- `shopkeeper_id`

---

### `ration_cards`
Family ration cards.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| card_number | varchar(50) | NOT NULL, UNIQUE | Ration card number |
| category | ration_category | NOT NULL | APL, BPL, or AAY |
| head_user_id | uuid | REFERENCES users, ON DELETE SET NULL | Head of household user |
| shop_id | uuid | NOT NULL, REFERENCES shops | Assigned shop |
| area_id | uuid | NOT NULL, REFERENCES areas | Area |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Indexes:**
- `shop_id`
- `area_id`
- `head_user_id`

---

### `family_members`
Members of each ration card family.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| ration_card_id | uuid | NOT NULL, REFERENCES ration_cards, ON DELETE CASCADE | Parent ration card |
| user_id | uuid | REFERENCES users, ON DELETE SET NULL | Linked user account |
| name | varchar(150) | NOT NULL | Member's name |
| age | integer | NOT NULL | Member's age |
| is_head | boolean | NOT NULL, DEFAULT false | Whether this is head of household |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Indexes:**
- `ration_card_id`
- `user_id`

---

### `wallets`
Current commodity balance for each ration card.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| ration_card_id | uuid | NOT NULL, UNIQUE, REFERENCES ration_cards, ON DELETE CASCADE | Ration card |
| rice_balance_kg | numeric(8,2) | NOT NULL, DEFAULT 0 | Rice balance (kg) |
| wheat_balance_kg | numeric(8,2) | NOT NULL, DEFAULT 0 | Wheat balance (kg) |
| sugar_balance_kg | numeric(8,2) | NOT NULL, DEFAULT 0 | Sugar balance (kg) |
| updated_at | timestamp | DEFAULT NOW() | Last update timestamp |

---

### `transactions`
Legacy manual dispensing transactions (pre-IoT).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| ration_card_id | uuid | NOT NULL, REFERENCES ration_cards, ON DELETE CASCADE | Beneficiary card |
| shop_id | uuid | NOT NULL, REFERENCES shops | Dispensing shop |
| dispensed_by | uuid | REFERENCES users, ON DELETE SET NULL | Shopkeeper who dispensed |
| rice_qty | numeric(8,2) | NOT NULL, DEFAULT 0 | Rice quantity (kg) |
| wheat_qty | numeric(8,2) | NOT NULL, DEFAULT 0 | Wheat quantity (kg) |
| sugar_qty | numeric(8,2) | NOT NULL, DEFAULT 0 | Sugar quantity (kg) |
| blockchain_tx_hash | text | | Blockchain transaction hash (NULL = pending) |
| created_at | timestamp | DEFAULT NOW() | Transaction timestamp |

**Indexes:**
- `ration_card_id`
- `shop_id`
- `created_at` (for analytics queries)

---

### `otp_verifications`
OTP storage for mobile verification.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| mobile | varchar(15) | NOT NULL | Mobile number |
| otp_hash | text | NOT NULL | Bcrypt hashed OTP |
| expires_at | timestamp | NOT NULL | Expiration time |
| is_used | boolean | NOT NULL, DEFAULT false | Whether OTP was used |
| created_at | timestamp | DEFAULT NOW() | Creation timestamp |

**Indexes:**
- `mobile`

---

## IoT Weighing System Tables

### `iot_devices`
Registry of ESP32 weighing devices.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| device_id | varchar(100) | NOT NULL, UNIQUE | Device hardware ID |
| device_name | varchar(150) | | Human-readable device name |
| device_token_hash | text | NOT NULL | Bcrypt hashed auth token |
| shop_id | uuid | REFERENCES shops, ON DELETE CASCADE | Assigned shop (nullable for unassigned devices) |
| status | varchar(20) | NOT NULL, DEFAULT 'active' | 'active', 'revoked', or 'inactive' |
| token_expires_at | timestamp | | Token expiry (NULL = no expiry) |
| token_grace_issued_at | timestamp | | Grace period start for token rotation |
| last_seen_at | timestamp | | Last activity timestamp |
| needs_recalibration | boolean | NOT NULL, DEFAULT false | Recalibration flag |
| calibrated_at | timestamp | | Last calibration timestamp |
| firmware_version | varchar(50) | | Firmware version reported by device |
| created_at | timestamp | NOT NULL, DEFAULT NOW() | Registration timestamp |

**Indexes:**
- `shop_id`
- `status`

**Notes:**
- Tokens are bcrypt-hashed (never stored in plaintext)
- `shop_id` is nullable to support unassigned devices (migration 026)
- Unassigned devices are rejected at WebSocket handshake

---

### `sensor_readings`
Raw weight readings from IoT devices.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| device_id | varchar(100) | NOT NULL, REFERENCES iot_devices(device_id), ON DELETE CASCADE | Source device |
| grams_int | integer | NOT NULL | Weight reading in grams |
| taken_at | timestamp | NOT NULL | When reading was taken |
| session_id | varchar(150) | | Associated dispense session (NULL in Phase 1) |
| created_at | timestamp | NOT NULL, DEFAULT NOW() | Persistence timestamp |

**Indexes:**
- `device_id`
- `taken_at`

**Notes:**
- Phase 1: Continuous streaming, `session_id` always NULL
- Phase 2+: Readings can be linked to dispense sessions

---

### `sensor_reading_rejections`
Log of rejected sensor readings for anomaly detection.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| device_id | varchar(100) | NOT NULL, REFERENCES iot_devices(device_id), ON DELETE CASCADE | Source device |
| rejected_at | timestamp | NOT NULL, DEFAULT NOW() | Rejection timestamp |

**Indexes:**
- `device_id`, `rejected_at` (composite)

**Notes:**
- Used to calculate rejection rate for DEVICE_ANOMALY rule
- Lightweight append-only log (no grams value stored)

---

### `dispense_sessions`
IoT-gated dispensing sessions (Phase 2).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| shop_id | uuid | NOT NULL, REFERENCES shops, ON DELETE CASCADE | Dispensing shop |
| ration_card_id | uuid | NOT NULL, REFERENCES ration_cards, ON DELETE CASCADE | Beneficiary card |
| commodity | varchar(20) | NOT NULL | 'rice', 'wheat', or 'sugar' |
| entitled_grams | integer | NOT NULL | Entitled quantity in grams |
| tolerance_grams | integer | NOT NULL | Acceptable variance |
| device_id | varchar(100) | REFERENCES iot_devices(device_id), ON DELETE SET NULL | Attached ESP32 device |
| state | varchar(30) | NOT NULL, DEFAULT 'active' | Session state (see below) |
| opened_at | timestamp | NOT NULL, DEFAULT NOW() | Session creation |
| expires_at | timestamp | NOT NULL | Expiration time |
| attached_at | timestamp | | When device was attached |
| committed_at | timestamp | | When dispense was committed |

**State Machine:**
- `active` → `attached` → `weighing` → `confirming` → `committed`
- Can transition to `cancelled`, `device_lost`, `failed_insufficient_balance`, or `expired`
- Can go back from `confirming` → `weighing` if rule breaks

**Indexes:**
- `device_id`, `state` (composite - for real-time lookup)
- `shop_id`
- `ration_card_id`

---

### `dispense_records`
Committed IoT-verified dispense ledger (Phase 2).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| session_id | uuid | NOT NULL, UNIQUE, REFERENCES dispense_sessions | Source session |
| ration_card_id | uuid | NOT NULL, REFERENCES ration_cards | Beneficiary card |
| shop_id | uuid | NOT NULL, REFERENCES shops | Dispensing shop |
| commodity | varchar(20) | NOT NULL | 'rice', 'wheat', or 'sugar' |
| entitled_grams | integer | NOT NULL | Entitled quantity |
| measured_grams | integer | NOT NULL | Actual measured quantity |
| prev_hash | text | | Hash of previous record in shop's chain (NULL for first) |
| row_hash | text | NOT NULL | Hash of this record |
| transaction_id | uuid | REFERENCES transactions | Linked transaction (added in migration 022) |
| anchor_error | text | | Blockchain anchor error if any |
| committed_at | timestamp | NOT NULL, DEFAULT NOW() | Commit timestamp |
| blockchain_tx_hash | text | | Blockchain transaction hash (NULL = pending retry) |

**Indexes:**
- `shop_id`, `committed_at` (composite - for chain lookup)
- `ration_card_id`
- `session_id` (unique)

**Notes:**
- Forms a per-shop hash chain (`prev_hash` → `row_hash`)
- One commodity per record (unlike `transactions` which is multi-commodity)
- Links to legacy `transactions` table via `transaction_id` (migration 022)

---

### `commodity_tolerances`
Per-commodity tolerance configuration.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| commodity | varchar(20) | PRIMARY KEY | 'rice', 'wheat', or 'sugar' |
| min_tolerance_grams | integer | NOT NULL, DEFAULT 20 | Minimum absolute tolerance |
| tolerance_pct | numeric(5,2) | NOT NULL, DEFAULT 1.00 | Percentage tolerance |

**Formula:**
```
tolerance_grams = GREATEST(min_tolerance_grams, ROUND(entitled_grams * tolerance_pct / 100))
```

**Seeded Data:**
- All commodities: 20g minimum, 1% percentage

---

### `used_jtis`
Single-use enforcement for session JWTs.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| jti | text | PRIMARY KEY | JWT ID from session token |
| session_id | uuid | NOT NULL, REFERENCES dispense_sessions, ON DELETE CASCADE | Associated session |
| used_at | timestamp | NOT NULL, DEFAULT NOW() | When token was consumed |

**Notes:**
- Prevents replay attacks on `/attach` endpoint
- Second use of same JTI → 409 IOT_SESSION_ALREADY_USED

---

## Anomaly Detection Tables

### `anomaly_events`
Legacy anomaly detection system (transaction-based, pre-IoT).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| type | varchar(50) | NOT NULL | Anomaly type |
| severity | varchar(20) | NOT NULL | 'info', 'warning', or 'critical' |
| shop_code | varchar(20) | | Shop code |
| transaction_id | uuid | REFERENCES transactions, ON DELETE SET NULL | Related transaction |
| description | text | NOT NULL | Human-readable description |
| created_at | timestamp | NOT NULL, DEFAULT NOW() | Detection timestamp |
| resolved | boolean | NOT NULL, DEFAULT false | Whether resolved |

**Indexes:**
- `created_at`
- `resolved`
- `transaction_id`

**Notes:**
- Populated by `anomalyDetectionCron.js` (transaction/shop analysis)
- No IoT awareness (predates IoT system)

---

### `anomaly_rules`
Configuration for IoT-specific streaming anomaly rules (Phase 3).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| rule_key | varchar(50) | PRIMARY KEY | Unique rule identifier |
| enabled | boolean | NOT NULL, DEFAULT true | Whether rule is active |
| severity | varchar(20) | NOT NULL | 'info', 'warn', or 'critical' |
| params_json | jsonb | NOT NULL, DEFAULT '{}' | Rule-specific parameters |
| created_at | timestamp | NOT NULL, DEFAULT NOW() | Creation timestamp |

**Seeded Rules:**

1. **NEAR_TOLERANCE**: Warns when dispenses consistently near tolerance edges
   - `edge_margin_grams: 10`
   - `window_days: 7`
   - `min_occurrences: 3`

2. **OFF_HOURS**: Warns about dispenses outside normal operating hours
   - `start_hour: 7`
   - `end_hour: 21`
   - `timezone: "Asia/Kolkata"`

3. **RAPID_FIRE**: Critical alert for suspiciously rapid dispenses
   - `max_commits_per_minute: 6`

4. **DEVICE_ANOMALY**: Critical alert for high rejection rate
   - `reject_pct_threshold: 5`
   - `window_hours: 24`

---

### `anomaly_flags`
Active anomaly flags raised by rule engine.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| rule_key | varchar(50) | NOT NULL, REFERENCES anomaly_rules | Which rule triggered |
| shop_id | uuid | NOT NULL, REFERENCES shops, ON DELETE CASCADE | Affected shop |
| device_id | varchar(100) | REFERENCES iot_devices(device_id), ON DELETE SET NULL | Affected device |
| dispense_record_id | uuid | REFERENCES dispense_records, ON DELETE SET NULL | Related dispense record |
| severity | varchar(20) | NOT NULL | Flag severity |
| description | text | NOT NULL | Human-readable description |
| created_at | timestamp | NOT NULL, DEFAULT NOW() | Flag creation |
| resolved_at | timestamp | | Manual admin resolution |
| auto_resolved_at | timestamp | | Automatic resolution when condition clears |

**Indexes:**
- `shop_id`
- `rule_key`
- `resolved_at`, `auto_resolved_at` (composite)

**Notes:**
- `resolved_at`: Manual admin action
- `auto_resolved_at`: Rule engine auto-resolution
- Both are independent and can coexist

---

## Audit & Logging Tables

### `iot_audit`
Audit trail for IoT-related admin actions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique identifier |
| actor_type | varchar(20) | NOT NULL | 'admin', 'shopkeeper', or 'system' |
| actor_id | uuid | | User ID of actor |
| action | varchar(50) | NOT NULL | Action type |
| target | text | NOT NULL | Action target description |
| at_time | timestamp | NOT NULL, DEFAULT NOW() | Action timestamp |
| meta_json | jsonb | NOT NULL, DEFAULT '{}' | Additional metadata |

**Indexes:**
- `action`
- `at_time`

**Common Actions:**
- Token rotation
- Recalibration trigger
- Manual session cancel
- Manual anomaly flag resolution

---

## Extensions & Custom Types

### PostgreSQL Extensions
- **pgcrypto**: For UUID generation (`gen_random_uuid()`)

### Custom Enum Types
- **user_role**: 'admin', 'shopkeeper', 'beneficiary'
- **ration_category**: 'APL', 'BPL', 'AAY'

---

## Key Relationships

### User & Authorization Flow
```
users (role) ← shopkeeper_id ← shops
users (role) ← head_user_id ← ration_cards
users (role) ← user_id ← family_members
```

### Beneficiary & Entitlement Flow
```
ration_cards (category) → policies → entitlement calculation
ration_cards → family_members (count) → total entitlement
ration_cards → wallets (balance tracking)
```

### IoT Dispensing Flow (Phase 2)
```
dispense_sessions → device_id → iot_devices
dispense_sessions → committed → dispense_records (hash chain)
dispense_records → blockchain_tx_hash (blockchain anchor)
iot_devices → sensor_readings (streaming weight data)
```

### Anomaly Detection Flow
```
anomaly_rules (config) → anomaly_flags (violations)
anomaly_flags → shop_id, device_id, dispense_record_id
sensor_reading_rejections → DEVICE_ANOMALY rule
```

### Blockchain Integration
```
transactions → blockchain_tx_hash (legacy manual dispenses)
dispense_records → blockchain_tx_hash (IoT dispenses)
dispense_records → prev_hash/row_hash (hash chain)
```

---

## Important Design Patterns

### Hash Chain (Per-Shop Ledger)
Each shop's `dispense_records` form a hash chain:
- First record: `prev_hash = NULL`
- Subsequent records: `prev_hash = previous_record.row_hash`
- Lookup: `ORDER BY committed_at DESC LIMIT 1 WHERE shop_id = ?`

### Blockchain Retry Pattern
Both `transactions` and `dispense_records`:
- `blockchain_tx_hash = NULL`: Pending blockchain anchoring
- `blockchain_tx_hash = '0x...'`: Successfully anchored
- Background job retries NULL records

### Token Security
- `users.password_hash`: Bcrypt hashed passwords
- `iot_devices.device_token_hash`: Bcrypt hashed device tokens
- `otp_verifications.otp_hash`: Bcrypt hashed OTPs
- Never store plaintext credentials

### Soft Deletion Pattern
Most foreign keys use `ON DELETE SET NULL` or `ON DELETE RESTRICT`:
- Preserves historical transaction integrity
- Prevents accidental cascade deletes
- Example: Deleting a user doesn't delete their transaction history

---

## Migration History

The schema evolved through 26 migrations:
- **001**: Initial core schema (users, shops, ration cards, wallets, transactions)
- **002**: Blockchain integration fields
- **003-004**: Schema refinements and missing columns
- **005**: Legacy anomaly detection system
- **006-012**: IoT Phase 1 & 2 (devices, readings, sessions, records)
- **013**: Schema drift reconciliation
- **014**: Device calibration tracking
- **015-016**: Phase 3 anomaly rules & flags
- **017**: Token rotation grace period
- **018**: IoT audit logging
- **019-020**: Anchor errors and rejection tracking
- **021**: Remove sugar commodity
- **022**: Link dispense records to transactions
- **023**: Per-card allocation in grams
- **024**: Commodity tolerance integrity
- **025**: Monthly claim unique indexes
- **026**: USB/serial device identity and assignment

---

## Schema Size Estimates

**High-Volume Tables** (expect millions of rows):
- `sensor_readings`: Continuous streaming from all devices
- `sensor_reading_rejections`: Rejection event log
- `transactions`: Historical dispenses
- `dispense_records`: IoT-verified dispenses

**Medium-Volume Tables** (thousands to hundreds of thousands):
- `ration_cards`, `family_members`: One per family
- `shops`: One per fair price shop
- `iot_devices`: One per ESP32 weighing device
- `dispense_sessions`: Active and historical sessions

**Low-Volume Tables** (configuration):
- `policies`, `areas`, `users`, `commodity_tolerances`
- `anomaly_rules`: Rule definitions
- `anomaly_flags`: Active violations only

---

## Database Performance Considerations

### Critical Indexes
- `dispense_sessions (device_id, state)`: Real-time IoT lookup
- `dispense_records (shop_id, committed_at)`: Hash chain traversal
- `sensor_readings (device_id, taken_at)`: Time-series queries
- `transactions (created_at)`: Analytics queries

### Hot Tables
- `sensor_readings`: High insert rate (continuous streaming)
- `dispense_sessions`: Frequent state updates during dispensing
- `wallets`: Updated on every dispense

### Consider Partitioning
- `sensor_readings`: Partition by `taken_at` (monthly/yearly)
- `dispense_records`: Partition by `committed_at` (yearly)
- `iot_audit`: Partition by `at_time` (monthly)

---

*Last Updated: Based on migration 026 (iot_device_identity_and_assignment)*
