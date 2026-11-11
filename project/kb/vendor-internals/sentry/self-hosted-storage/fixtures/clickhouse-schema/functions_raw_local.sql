CREATE TABLE default.functions_raw_local
(
    `project_id` UInt64,
    `transaction_name` String,
    `timestamp` DateTime,
    `end_timestamp` Nullable(DateTime64(6)) CODEC(DoubleDelta),
    `start_timestamp` Nullable(DateTime64(6)) CODEC(DoubleDelta),
    `depth` UInt32,
    `parent_fingerprint` UInt64,
    `fingerprint` UInt64,
    `name` String,
    `function` String,
    `package` String,
    `module` String,
    `path` String,
    `is_application` UInt8,
    `platform` LowCardinality(String),
    `environment` LowCardinality(Nullable(String)),
    `release` LowCardinality(Nullable(String)),
    `dist` LowCardinality(Nullable(String)),
    `transaction_op` LowCardinality(String),
    `transaction_status` UInt8 DEFAULT 2,
    `http_method` LowCardinality(Nullable(String)),
    `browser_name` LowCardinality(Nullable(String)),
    `device_classification` UInt8,
    `os_name` LowCardinality(String),
    `os_version` LowCardinality(String),
    `retention_days` UInt16,
    `durations` Array(Float64),
    `profile_id` UUID,
    `materialization_version` UInt8,
    `thread_id` String,
    `profiling_type` LowCardinality(String) DEFAULT 'transaction'
)
ENGINE = MergeTree
PARTITION BY toStartOfInterval(timestamp, toIntervalHour(12))
ORDER BY (project_id, transaction_name, timestamp)
TTL timestamp + toIntervalDay(1)
SETTINGS index_granularity = 8192
