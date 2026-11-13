// The one client of the plugin's backend (ADR-0023): every request of the spec-wire pages goes
// through here, to /api/plugins/<id>/resources/v1/..., with the Grafana session cookie. The
// backend applies Clearance; the kit's client only fetches.
import { createBffClient } from '@ouo11y/kit';
import { PLUGIN_ID } from '../constants';

export const BFF_BASE = `/api/plugins/${PLUGIN_ID}/resources`;

export const bff = createBffClient({ baseUrl: BFF_BASE });

export { BffError, useBff, type Async } from '@ouo11y/kit';
