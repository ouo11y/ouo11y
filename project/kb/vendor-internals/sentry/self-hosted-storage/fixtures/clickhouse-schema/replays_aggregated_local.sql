CREATE TABLE default.replays_aggregated_local
(
    `project_id` UInt64,
    `to_hour_timestamp` DateTime,
    `replay_id` UUID,
    `retention_days` UInt16,
    `browser_name` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `browser_version` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `count_dead_clicks` AggregateFunction(sum, UInt64),
    `count_errors` AggregateFunction(sum, UInt64),
    `count_infos` AggregateFunction(sum, UInt64),
    `count_rage_clicks` AggregateFunction(sum, UInt64),
    `count_segments` AggregateFunction(count, Nullable(UInt64)),
    `count_urls` AggregateFunction(sum, UInt64),
    `count_warnings` AggregateFunction(sum, UInt64),
    `device_brand` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `device_family` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `device_model` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `device_name` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `dist` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `environment` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `finished_at` AggregateFunction(maxIf, DateTime, UInt8),
    `ip_address_v4` AggregateFunction(any, Nullable(IPv4)),
    `ip_address_v6` AggregateFunction(any, Nullable(IPv6)),
    `is_archived` AggregateFunction(sum, Nullable(UInt64)),
    `min_segment_id` AggregateFunction(min, Nullable(UInt16)),
    `os_name` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `os_version` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `platform` AggregateFunction(anyIf, String, UInt8),
    `sdk_name` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `sdk_version` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `started_at` AggregateFunction(min, Nullable(DateTime)),
    `user` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `user_id` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `user_name` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8)),
    `user_email` AggregateFunction(anyIf, Nullable(String), Nullable(UInt8))
)
ENGINE = AggregatingMergeTree
PARTITION BY (retention_days, toMonday(to_hour_timestamp))
ORDER BY (project_id, to_hour_timestamp, replay_id, retention_days)
TTL to_hour_timestamp + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192
