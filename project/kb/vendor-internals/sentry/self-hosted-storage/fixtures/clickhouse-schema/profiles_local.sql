CREATE TABLE default.profiles_local
(
    `organization_id` UInt64,
    `project_id` UInt64,
    `transaction_id` UUID,
    `profile_id` UUID,
    `received` DateTime,
    `android_api_level` Nullable(UInt32),
    `device_classification` LowCardinality(String),
    `device_locale` LowCardinality(String),
    `device_manufacturer` LowCardinality(String),
    `device_model` LowCardinality(String),
    `device_os_build_number` LowCardinality(Nullable(String)),
    `device_os_name` LowCardinality(String),
    `device_os_version` LowCardinality(String),
    `architecture` LowCardinality(String) DEFAULT 'unknown',
    `duration_ns` UInt64,
    `environment` LowCardinality(Nullable(String)),
    `platform` LowCardinality(String),
    `trace_id` UUID,
    `transaction_name` LowCardinality(String),
    `version_name` String,
    `version_code` String,
    `retention_days` UInt16,
    `partition` UInt16,
    `offset` UInt64
)
ENGINE = ReplacingMergeTree
PARTITION BY (retention_days, toMonday(received))
ORDER BY (organization_id, project_id, toStartOfDay(received), cityHash64(profile_id))
SAMPLE BY cityHash64(profile_id)
TTL received + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192, enable_vertical_merge_algorithm = 0
