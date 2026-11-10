CREATE TABLE default.llm_proxy_cost_raw_local
(
    `timestamp` DateTime,
    `org_id` UInt64,
    `project_id` UInt64,
    `feature` LowCardinality(String),
    `model` LowCardinality(String),
    `region` LowCardinality(String),
    `call_type` LowCardinality(String),
    `prompt_tokens` UInt32,
    `completion_tokens` UInt32,
    `cache_read_tokens` UInt32,
    `cache_write_tokens` UInt32,
    `total_cost_usd` Float64,
    `input_cost_usd` Float64,
    `output_cost_usd` Float64,
    `cache_read_cost_usd` Float64,
    `cache_write_cost_usd` Float64,
    `litellm_cost_usd` Float64,
    `is_long_context` UInt8,
    `is_regional` UInt8,
    `response_time_ms` Float64,
    `litellm_call_id` String
)
ENGINE = MergeTree
PARTITION BY toStartOfMonth(timestamp)
ORDER BY (org_id, project_id, timestamp)
TTL timestamp + toIntervalDay(365)
SETTINGS index_granularity = 8192
