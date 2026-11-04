import React, { useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2, type SelectableValue } from '@grafana/data';
import { Button, IconButton, Input, Select, Stack, useStyles2 } from '@grafana/ui';
import type { FunnelCondition, FunnelConditionOp } from '../api/types';
import { MAX_CONDITIONS } from '../utils/funnel';

const OP_OPTIONS: Array<SelectableValue<FunnelConditionOp>> = [
  { label: '=', value: '=', description: 'equals' },
  { label: '≠', value: '!=', description: 'differs from (or is missing, when the value is not empty)' },
  { label: 'matches', value: '=~', description: 'RE2 regular expression, whole value' },
];

interface Props {
  /** Accessible prefix, e.g. "Step 2" or "Failure". */
  label: string;
  conditions: FunnelCondition[];
  /** Called with the complete conditions (rows without a key are kept only here). */
  onChange: (next: FunnelCondition[]) => void;
}

interface Row {
  key: string;
  op: FunnelConditionOp;
  value: string;
}

function rowsFrom(cs: FunnelCondition[]): Row[] {
  return cs.map((c) => ({ key: c.key, op: c.op ?? '=', value: c.value }));
}

/**
 * `where` conditions of an event step (ADR-0019): attribute, operator, value. Text is committed on blur
 * or Enter so typing does not query rum-api on every key; a row without an attribute stays local.
 */
export function ConditionEditor({ label, conditions, onChange }: Props) {
  const styles = useStyles2(getStyles);
  const synced = JSON.stringify(conditions);
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(conditions));
  const [syncedFrom, setSyncedFrom] = useState(synced);
  if (syncedFrom !== synced) {
    setSyncedFrom(synced);
    setRows(rowsFrom(conditions));
  }

  const commit = (next: Row[]) => {
    const complete = next
      .filter((r) => r.key.trim() !== '')
      .map((r) => ({ key: r.key.trim(), op: r.op, value: r.value }));
    if (JSON.stringify(complete) !== synced) {
      onChange(complete);
    }
  };
  const edit = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className={styles.box}>
      {rows.map((r, i) => (
        <Stack key={i} gap={1} alignItems="center">
          <span className={styles.word}>{i === 0 ? 'where' : 'and'}</span>
          <Input
            aria-label={`${label} condition ${i + 1} attribute`}
            width={24}
            placeholder="attribute, e.g. payment.method"
            value={r.key}
            onChange={(e) => edit(i, { key: e.currentTarget.value })}
            onBlur={() => commit(rows)}
            onKeyDown={(e) => e.key === 'Enter' && commit(rows)}
          />
          <Select
            aria-label={`${label} condition ${i + 1} operator`}
            width={12}
            options={OP_OPTIONS}
            value={r.op}
            onChange={(v) => {
              const next = rows.map((x, j) => (j === i ? { ...x, op: v.value ?? '=' } : x));
              setRows(next);
              commit(next);
            }}
          />
          <Input
            aria-label={`${label} condition ${i + 1} value`}
            width={24}
            placeholder={r.op === '=~' ? 'pattern, e.g. card|wallet' : 'value'}
            value={r.value}
            onChange={(e) => edit(i, { value: e.currentTarget.value })}
            onBlur={() => commit(rows)}
            onKeyDown={(e) => e.key === 'Enter' && commit(rows)}
          />
          <IconButton
            name="times"
            tooltip="Remove condition"
            aria-label={`${label} remove condition ${i + 1}`}
            onClick={() => {
              const next = rows.filter((_, j) => j !== i);
              setRows(next);
              commit(next);
            }}
          />
        </Stack>
      ))}
      <Button
        size="sm"
        variant="secondary"
        fill="text"
        icon="plus"
        disabled={rows.length >= MAX_CONDITIONS}
        aria-label={`${label} add condition`}
        onClick={() => setRows([...rows, { key: '', op: '=', value: '' }])}
      >
        {rows.length === 0 ? 'Where…' : 'And…'}
      </Button>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  box: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.5), alignItems: 'flex-start' }),
  word: css({ width: theme.spacing(5), color: theme.colors.text.secondary, textAlign: 'right' }),
});
