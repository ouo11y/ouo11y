CREATE TABLE default.outcomes_daily_local_v2
(
    `org_id` UInt64,
    `project_id` UInt64,
    `key_id` UInt64,
    `timestamp` DateTime,
    `outcome` UInt8,
    `reason` LowCardinality(String),
    `category` UInt8,
    `quantity` UInt64,
    `times_seen` UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toStartOfMonth(timestamp)
ORDER BY (org_id, project_id, key_id, outcome, reason, timestamp, category)
TTL timestamp + toIntervalMonth(13)
SETTINGS index_granularity = 8192
