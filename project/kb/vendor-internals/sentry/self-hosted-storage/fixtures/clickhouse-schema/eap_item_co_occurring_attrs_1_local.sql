CREATE TABLE default.eap_item_co_occurring_attrs_1_local
(
    `organization_id` UInt64,
    `project_id` UInt64,
    `item_type` UInt8,
    `date` Date CODEC(DoubleDelta, ZSTD(1)),
    `retention_days` UInt16,
    `attribute_keys_hash` Array(UInt64) MATERIALIZED arrayMap(k -> cityHash64(k), arrayDistinct(arrayConcat(attributes_string, attributes_float, attributes_bool))),
    `attributes_string` Array(String),
    `attributes_float` Array(String),
    `attributes_bool` Array(String),
    `key_hash` UInt64 DEFAULT cityHash64(arraySort(arrayConcat(attributes_string, attributes_float, attributes_bool))),
    INDEX bf_attribute_keys_hash attribute_keys_hash TYPE bloom_filter GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY (retention_days, toMonday(date))
PRIMARY KEY (organization_id, project_id, date, item_type, key_hash)
ORDER BY (organization_id, project_id, date, item_type, key_hash, retention_days)
TTL date + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192
