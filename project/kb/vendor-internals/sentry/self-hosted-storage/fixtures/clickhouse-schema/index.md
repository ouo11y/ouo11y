# sentry / self-hosted-storage / fixtures / clickhouse-schema

`SHOW CREATE TABLE` for all 49 objects of database `default`, one `.sql` per table, plus `_engines.tsv` (engine, partition, order, TTL per table)

| Path | What it is |
|---|---|
| [_engines.tsv](_engines.tsv) | Engine, ORDER BY, partition key and TTL of every table |
| [discover_local.sql](discover_local.sql) | `SHOW CREATE TABLE` output for `discover_local` |
| [eap_item_co_occurring_attrs_1_local.sql](eap_item_co_occurring_attrs_1_local.sql) | `SHOW CREATE TABLE` output for `eap_item_co_occurring_attrs_1_local` |
| [eap_item_co_occurring_attrs_2_local.sql](eap_item_co_occurring_attrs_2_local.sql) | `SHOW CREATE TABLE` output for `eap_item_co_occurring_attrs_2_local` |
| [eap_item_co_occurring_attrs_3_mv.sql](eap_item_co_occurring_attrs_3_mv.sql) | `SHOW CREATE TABLE` output for `eap_item_co_occurring_attrs_3_mv` |
| [eap_item_co_occurring_attrs_4_mv.sql](eap_item_co_occurring_attrs_4_mv.sql) | `SHOW CREATE TABLE` output for `eap_item_co_occurring_attrs_4_mv` |
| [eap_items_1_downsample_512_local.sql](eap_items_1_downsample_512_local.sql) | `SHOW CREATE TABLE` output for `eap_items_1_downsample_512_local` |
| [eap_items_1_downsample_512_mv_10.sql](eap_items_1_downsample_512_mv_10.sql) | `SHOW CREATE TABLE` output for `eap_items_1_downsample_512_mv_10` |
| [eap_items_1_downsample_64_local.sql](eap_items_1_downsample_64_local.sql) | `SHOW CREATE TABLE` output for `eap_items_1_downsample_64_local` |
| [eap_items_1_downsample_64_mv_10.sql](eap_items_1_downsample_64_mv_10.sql) | `SHOW CREATE TABLE` output for `eap_items_1_downsample_64_mv_10` |
| [eap_items_1_downsample_8_local.sql](eap_items_1_downsample_8_local.sql) | `SHOW CREATE TABLE` output for `eap_items_1_downsample_8_local` |
| [eap_items_1_downsample_8_mv_10.sql](eap_items_1_downsample_8_mv_10.sql) | `SHOW CREATE TABLE` output for `eap_items_1_downsample_8_mv_10` |
| [eap_items_1_local.sql](eap_items_1_local.sql) | `SHOW CREATE TABLE` output for `eap_items_1_local` |
| [eap_items_2_downsample_512_local.sql](eap_items_2_downsample_512_local.sql) | `SHOW CREATE TABLE` output for `eap_items_2_downsample_512_local` |
| [eap_items_2_downsample_512_mv_1.sql](eap_items_2_downsample_512_mv_1.sql) | `SHOW CREATE TABLE` output for `eap_items_2_downsample_512_mv_1` |
| [eap_items_2_downsample_64_local.sql](eap_items_2_downsample_64_local.sql) | `SHOW CREATE TABLE` output for `eap_items_2_downsample_64_local` |
| [eap_items_2_downsample_64_mv_1.sql](eap_items_2_downsample_64_mv_1.sql) | `SHOW CREATE TABLE` output for `eap_items_2_downsample_64_mv_1` |
| [eap_items_2_downsample_8_local.sql](eap_items_2_downsample_8_local.sql) | `SHOW CREATE TABLE` output for `eap_items_2_downsample_8_local` |
| [eap_items_2_downsample_8_mv_1.sql](eap_items_2_downsample_8_mv_1.sql) | `SHOW CREATE TABLE` output for `eap_items_2_downsample_8_mv_1` |
| [eap_items_2_local.sql](eap_items_2_local.sql) | `SHOW CREATE TABLE` output for `eap_items_2_local` |
| [errors_local.sql](errors_local.sql) | `SHOW CREATE TABLE` output for `errors_local` |
| [functions_local.sql](functions_local.sql) | `SHOW CREATE TABLE` output for `functions_local` |
| [functions_mv_local.sql](functions_mv_local.sql) | `SHOW CREATE TABLE` output for `functions_mv_local` |
| [functions_raw_local.sql](functions_raw_local.sql) | `SHOW CREATE TABLE` output for `functions_raw_local` |
| [functions_v2_local.sql](functions_v2_local.sql) | `SHOW CREATE TABLE` output for `functions_v2_local` |
| [group_attributes_local.sql](group_attributes_local.sql) | `SHOW CREATE TABLE` output for `group_attributes_local` |
| [groupassignee_local.sql](groupassignee_local.sql) | `SHOW CREATE TABLE` output for `groupassignee_local` |
| [groupedmessage_local.sql](groupedmessage_local.sql) | `SHOW CREATE TABLE` output for `groupedmessage_local` |
| [llm_proxy_cost_raw_local.sql](llm_proxy_cost_raw_local.sql) | `SHOW CREATE TABLE` output for `llm_proxy_cost_raw_local` |
| [metrics_counters_polymorphic_mv_v4_local.sql](metrics_counters_polymorphic_mv_v4_local.sql) | `SHOW CREATE TABLE` output for `metrics_counters_polymorphic_mv_v4_local` |
| [metrics_counters_v2_local.sql](metrics_counters_v2_local.sql) | `SHOW CREATE TABLE` output for `metrics_counters_v2_local` |
| [metrics_distributions_polymorphic_mv_v4_local.sql](metrics_distributions_polymorphic_mv_v4_local.sql) | `SHOW CREATE TABLE` output for `metrics_distributions_polymorphic_mv_v4_local` |
| [metrics_distributions_v2_local.sql](metrics_distributions_v2_local.sql) | `SHOW CREATE TABLE` output for `metrics_distributions_v2_local` |
| [metrics_raw_v2_local.sql](metrics_raw_v2_local.sql) | `SHOW CREATE TABLE` output for `metrics_raw_v2_local` |
| [metrics_sets_polymorphic_mv_v4_local.sql](metrics_sets_polymorphic_mv_v4_local.sql) | `SHOW CREATE TABLE` output for `metrics_sets_polymorphic_mv_v4_local` |
| [metrics_sets_v2_local.sql](metrics_sets_v2_local.sql) | `SHOW CREATE TABLE` output for `metrics_sets_v2_local` |
| [migrations_local.sql](migrations_local.sql) | `SHOW CREATE TABLE` output for `migrations_local` |
| [outcomes_daily_local_v2.sql](outcomes_daily_local_v2.sql) | `SHOW CREATE TABLE` output for `outcomes_daily_local_v2` |
| [outcomes_hourly_local.sql](outcomes_hourly_local.sql) | `SHOW CREATE TABLE` output for `outcomes_hourly_local` |
| [outcomes_mv_daily_local_v3.sql](outcomes_mv_daily_local_v3.sql) | `SHOW CREATE TABLE` output for `outcomes_mv_daily_local_v3` |
| [outcomes_mv_hourly_local_v2.sql](outcomes_mv_hourly_local_v2.sql) | `SHOW CREATE TABLE` output for `outcomes_mv_hourly_local_v2` |
| [outcomes_raw_local.sql](outcomes_raw_local.sql) | `SHOW CREATE TABLE` output for `outcomes_raw_local` |
| [profile_chunks_local.sql](profile_chunks_local.sql) | `SHOW CREATE TABLE` output for `profile_chunks_local` |
| [profiles_local.sql](profiles_local.sql) | `SHOW CREATE TABLE` output for `profiles_local` |
| [replays_aggregated_local.sql](replays_aggregated_local.sql) | `SHOW CREATE TABLE` output for `replays_aggregated_local` |
| [replays_aggregation_mv.sql](replays_aggregation_mv.sql) | `SHOW CREATE TABLE` output for `replays_aggregation_mv` |
| [replays_local.sql](replays_local.sql) | `SHOW CREATE TABLE` output for `replays_local` |
| [search_issues_local.sql](search_issues_local.sql) | `SHOW CREATE TABLE` output for `search_issues_local` |
| [search_issues_local_v2.sql](search_issues_local_v2.sql) | `SHOW CREATE TABLE` output for `search_issues_local_v2` |
| [transactions_local.sql](transactions_local.sql) | `SHOW CREATE TABLE` output for `transactions_local` |
