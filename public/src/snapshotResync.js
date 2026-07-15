const CANONICAL = new Set(['client-request','sequence-gap','epoch-change','static-revision','reconnect','heartbeat-timeout','malformed-snapshot']);
const MAP = Object.freeze({
  'sequence-gap': 'sequence-gap',
  'wrong-base': 'sequence-gap',
  'missing-baseline': 'client-request',
  'static-revision-mismatch': 'static-revision',
  'malformed-delta': 'malformed-snapshot',
  'incompatible-snapshot': 'malformed-snapshot',
  'malformed-snapshot': 'malformed-snapshot',
  'stale-epoch': 'epoch-change',
  'epoch-mismatch': 'epoch-change',
  'missing-epoch-baseline': 'epoch-change',
  'reconnect': 'reconnect',
  'reconnect-recovery': 'reconnect',
  'heartbeat-timeout': 'heartbeat-timeout'
});
export function mapSnapshotRejectionToResyncReason(localReason) {
  const key = typeof localReason === 'string' ? localReason.trim() : '';
  const mapped = MAP[key] || 'client-request';
  return CANONICAL.has(mapped) ? mapped : 'client-request';
}
