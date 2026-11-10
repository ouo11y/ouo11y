CREATE TABLE default.profile_chunks_local
(
    `project_id` UInt64,
    `profiler_id` UUID,
    `chunk_id` UUID,
    `start_timestamp` DateTime64(6) CODEC(DoubleDelta),
    `end_timestamp` DateTime64(6) CODEC(DoubleDelta),
    `environment` LowCardinality(Nullable(String)),
    `retention_days` UInt16,
    `partition` UInt16,
    `offset` UInt64
)
ENGINE = ReplacingMergeTree
PARTITION BY (retention_days, toStartOfDay(start_timestamp))
ORDER BY (project_id, profiler_id, start_timestamp, cityHash64(chunk_id))
SAMPLE BY cityHash64(chunk_id)
TTL toDateTime(end_timestamp) + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192
