/**
 * The keepalive budget. Browsers refuse a `keepalive` request (fetch or `sendBeacon`) once the
 * bodies of the keepalive requests in flight would exceed 64 KiB in total, and Chromium also
 * refuses more than 9 of them at once (whatwg/fetch#679). Every SDK request reserves here before
 * asking for `keepalive`; 60 KB leaves room for headers.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
export const KEEPALIVE_MAX_REQUESTS = 9;

let pendingBytes = 0;
let pendingRequests = 0;

/** Reserves `bytes` of the budget; false when the request must go without `keepalive`. */
export function reserveKeepalive(bytes: number): boolean {
  if (pendingRequests >= KEEPALIVE_MAX_REQUESTS || pendingBytes + bytes > KEEPALIVE_MAX_BYTES) return false;
  pendingBytes += bytes;
  pendingRequests += 1;
  return true;
}

export function releaseKeepalive(bytes: number): void {
  pendingBytes = Math.max(0, pendingBytes - bytes);
  pendingRequests = Math.max(0, pendingRequests - 1);
}

/** Bytes a new keepalive request may still carry (0 when the request count is used up). */
export function keepaliveRemaining(): number {
  return pendingRequests >= KEEPALIVE_MAX_REQUESTS ? 0 : KEEPALIVE_MAX_BYTES - pendingBytes;
}
