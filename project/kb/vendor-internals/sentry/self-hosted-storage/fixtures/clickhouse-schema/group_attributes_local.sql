CREATE TABLE default.group_attributes_local
(
    `project_id` UInt64,
    `group_id` UInt64,
    `group_status` UInt8,
    `group_substatus` Nullable(UInt8),
    `group_priority` Nullable(UInt8),
    `group_first_release` Nullable(UInt64),
    `group_first_release_id` Nullable(UUID),
    `group_first_seen` DateTime,
    `group_num_comments` UInt64,
    `assignee_user_id` Nullable(UInt64),
    `assignee_team_id` Nullable(UInt64),
    `owner_suspect_commit_user_id` Nullable(UInt64),
    `owner_ownership_rule_user_id` Nullable(UInt64),
    `owner_ownership_rule_team_id` Nullable(UInt64),
    `owner_codeowners_user_id` Nullable(UInt64),
    `owner_codeowners_team_id` Nullable(UInt64),
    `deleted` UInt8,
    `message_timestamp` DateTime,
    `partition` UInt16,
    `offset` UInt64
)
ENGINE = ReplacingMergeTree(deleted)
ORDER BY (project_id, group_id)
SETTINGS index_granularity = 8192
