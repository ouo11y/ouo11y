CREATE MATERIALIZED VIEW default.eap_item_co_occurring_attrs_4_mv TO default.eap_item_co_occurring_attrs_2_local
(
    `organization_id` UInt64,
    `project_id` UInt64,
    `item_type` UInt8,
    `date` Date CODEC(DoubleDelta, ZSTD(1)),
    `retention_days` UInt16,
    `attributes_string` Array(String),
    `attributes_float` Array(String),
    `attributes_int` Array(String),
    `attributes_bool` Array(String),
    `attributes_array_string` Array(String),
    `attributes_array_int` Array(String),
    `attributes_array_float` Array(String),
    `attributes_array_bool` Array(String),
    `count` UInt64,
    `last_seen` SimpleAggregateFunction(max, DateTime)
)
AS SELECT
    organization_id AS organization_id,
    project_id AS project_id,
    item_type AS item_type,
    toMonday(timestamp) AS date,
    retention_days AS retention_days,
    arrayConcat(mapKeys(attributes_string_0), mapKeys(attributes_string_1), mapKeys(attributes_string_2), mapKeys(attributes_string_3), mapKeys(attributes_string_4), mapKeys(attributes_string_5), mapKeys(attributes_string_6), mapKeys(attributes_string_7), mapKeys(attributes_string_8), mapKeys(attributes_string_9), mapKeys(attributes_string_10), mapKeys(attributes_string_11), mapKeys(attributes_string_12), mapKeys(attributes_string_13), mapKeys(attributes_string_14), mapKeys(attributes_string_15), mapKeys(attributes_string_16), mapKeys(attributes_string_17), mapKeys(attributes_string_18), mapKeys(attributes_string_19), mapKeys(attributes_string_20), mapKeys(attributes_string_21), mapKeys(attributes_string_22), mapKeys(attributes_string_23), mapKeys(attributes_string_24), mapKeys(attributes_string_25), mapKeys(attributes_string_26), mapKeys(attributes_string_27), mapKeys(attributes_string_28), mapKeys(attributes_string_29), mapKeys(attributes_string_30), mapKeys(attributes_string_31), mapKeys(attributes_string_32), mapKeys(attributes_string_33), mapKeys(attributes_string_34), mapKeys(attributes_string_35), mapKeys(attributes_string_36), mapKeys(attributes_string_37), mapKeys(attributes_string_38), mapKeys(attributes_string_39)) AS attributes_string,
    arrayConcat(mapKeys(attributes_float_0), mapKeys(attributes_float_1), mapKeys(attributes_float_2), mapKeys(attributes_float_3), mapKeys(attributes_float_4), mapKeys(attributes_float_5), mapKeys(attributes_float_6), mapKeys(attributes_float_7), mapKeys(attributes_float_8), mapKeys(attributes_float_9), mapKeys(attributes_float_10), mapKeys(attributes_float_11), mapKeys(attributes_float_12), mapKeys(attributes_float_13), mapKeys(attributes_float_14), mapKeys(attributes_float_15), mapKeys(attributes_float_16), mapKeys(attributes_float_17), mapKeys(attributes_float_18), mapKeys(attributes_float_19), mapKeys(attributes_float_20), mapKeys(attributes_float_21), mapKeys(attributes_float_22), mapKeys(attributes_float_23), mapKeys(attributes_float_24), mapKeys(attributes_float_25), mapKeys(attributes_float_26), mapKeys(attributes_float_27), mapKeys(attributes_float_28), mapKeys(attributes_float_29), mapKeys(attributes_float_30), mapKeys(attributes_float_31), mapKeys(attributes_float_32), mapKeys(attributes_float_33), mapKeys(attributes_float_34), mapKeys(attributes_float_35), mapKeys(attributes_float_36), mapKeys(attributes_float_37), mapKeys(attributes_float_38), mapKeys(attributes_float_39)) AS attributes_float,
    mapKeys(attributes_int) AS attributes_int,
    mapKeys(attributes_bool) AS attributes_bool,
    mapKeys(attributes_array_string) AS attributes_array_string,
    mapKeys(attributes_array_int) AS attributes_array_int,
    mapKeys(attributes_array_float) AS attributes_array_float,
    mapKeys(attributes_array_bool) AS attributes_array_bool,
    1 AS count,
    timestamp AS last_seen
FROM default.eap_items_2_local
