CREATE TABLE default.functions_mv_local
(
    `project_id` UInt64,
    `transaction_name` String,
    `timestamp` DateTime,
    `depth` UInt32,
    `parent_fingerprint` UInt64,
    `fingerprint` UInt64,
    `name` String,
    `package` String,
    `path` String,
    `is_application` UInt8,
    `profiling_type` SimpleAggregateFunction(any, LowCardinality(String)) DEFAULT 'transaction',
    `platform` LowCardinality(String),
    `environment` LowCardinality(Nullable(String)),
    `release` LowCardinality(Nullable(String)),
    `os_name` LowCardinality(String),
    `os_version` LowCardinality(String),
    `retention_days` UInt16,
    `count` AggregateFunction(count, Float64),
    `percentiles` AggregateFunction(quantiles(0.5, 0.75, 0.9, 0.95, 0.99), Float64),
    `min` AggregateFunction(min, Float64),
    `max` AggregateFunction(max, Float64),
    `avg` AggregateFunction(avg, Float64),
    `sum` AggregateFunction(sum, Float64),
    `worst` AggregateFunction(argMax, UUID, Float64),
    `worst_v2` AggregateFunction(argMax, Tuple(
        UUID,
        String,
        Nullable(DateTime64(6)),
        Nullable(DateTime64(6))), Float64),
    `examples` AggregateFunction(groupUniqArray(5), UUID),
    `examples_v2` AggregateFunction(groupUniqArray(5), Tuple(
        UUID,
        String,
        Nullable(DateTime64(6)),
        Nullable(DateTime64(6))))
)
ENGINE = AggregatingMergeTree
PARTITION BY (retention_days, toMonday(timestamp))
PRIMARY KEY (project_id, transaction_name, timestamp, depth, parent_fingerprint, fingerprint)
ORDER BY (project_id, transaction_name, timestamp, depth, parent_fingerprint, fingerprint, name, package, path, is_application, platform, environment, release, os_name, os_version, retention_days)
TTL timestamp + toIntervalDay(retention_days)
SETTINGS index_granularity = 2048, allow_nullable_key = 1
