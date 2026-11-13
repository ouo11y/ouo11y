import React from 'react';
import { Alert } from '@grafana/ui';
import type { FieldGroup, Me } from '@ouo11y/kit';

const LABEL: Record<FieldGroup, string> = {
  attributes: 'event attributes',
  replay: 'replays',
  identity: 'user identity',
};

/** Says what the backend left out of the answers for this user's Clearance level. */
export function ClearanceNote({ me, redacted }: { me?: Me; redacted?: FieldGroup[] }) {
  if (!me || !redacted?.length) {
    return null;
  }
  return (
    <Alert severity="info" title={`Clearance c${me.level}`} data-testid="clearance-note">
      Hidden by your clearance: {redacted.map((g) => LABEL[g] ?? g).join(', ')}. Ask an admin for a higher level.
    </Alert>
  );
}
