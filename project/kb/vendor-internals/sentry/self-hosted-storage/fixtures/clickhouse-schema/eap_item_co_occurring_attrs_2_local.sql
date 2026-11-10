CREATE TABLE default.eap_item_co_occurring_attrs_2_local
(
    `organization_id` UInt64,
    `project_id` UInt64,
    `item_type` UInt8,
    `date` Date CODEC(DoubleDelta, ZSTD(1)),
    `retention_days` UInt16,
    `attribute_keys_hash` Array(UInt64) MATERIALIZED arrayMap(k -> cityHash64(k), arrayDistinct(arrayConcat(attributes_string, attributes_float, attributes_int, attributes_bool, attributes_array_string, attributes_array_int, attributes_array_float, attributes_array_bool))),
    `attributes_string` Array(String),
    `attributes_float` Array(String),
    `attributes_int` Array(String),
    `attributes_bool` Array(String),
    `attributes_array_string` Array(String),
    `attributes_array_int` Array(String),
    `attributes_array_float` Array(String),
    `attributes_array_bool` Array(String),
    `key_hash` UInt64 MATERIALIZED cityHash64(arraySort(arrayDistinct(arrayConcat(attributes_string, attributes_float, attributes_int, attributes_bool, attributes_array_string, attributes_array_int, attributes_array_float, attributes_array_bool)))),
    `count` UInt64,
    `last_seen` SimpleAggregateFunction(max, DateTime),
    INDEX bf_attribute_keys_hash attribute_keys_hash TYPE bloom_filter GRANULARITY 1
)
ENGINE = SummingMergeTree
PARTITION BY (retention_days, toMonday(date))
PRIMARY KEY (organization_id, project_id, date, item_type, key_hash)
ORDER BY (organization_id, project_id, date, item_type, key_hash, retention_days)
TTL date + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192
