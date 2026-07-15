const { PROTOCOL_VERSION } = require('./buildInfo');

const MIN_CLIENT_PROTOCOL = 4;
const MAX_CLIENT_PROTOCOL = 4;
const MIN_SERVER_PROTOCOL = 4;
const MAX_SERVER_PROTOCOL = 4;
const REQUIRED_CAPABILITIES = Object.freeze(['messagepack']);
const OPTIONAL_CAPABILITIES = Object.freeze(['resume-v1', 'heartbeat-v1']);

const ERROR_CODES = Object.freeze({
  BAD_MESSAGE: 'bad-message', MESSAGE_TOO_LARGE: 'message-too-large', PROTOCOL_ERROR: 'protocol-error',
  INCOMPATIBLE_PROTOCOL: 'incompatible-protocol', MISSING_CAPABILITY: 'missing-capability', JOIN_REQUIRED: 'join-required',
  STALE_ATTACHMENT: 'stale-attachment', RATE_LIMITED: 'rate-limited', INVALID_REQUEST: 'invalid-request', INVALID_PAYLOAD: 'invalid-payload'
});

function protocolInfo() {
  return { protocolVersion: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL, maxClientProtocol: MAX_CLIENT_PROTOCOL, minServerProtocol: MIN_SERVER_PROTOCOL, maxServerProtocol: MAX_SERVER_PROTOCOL, capabilities: [...REQUIRED_CAPABILITIES, ...OPTIONAL_CAPABILITIES] };
}

function negotiate(clientInfo = {}) {
  const v = Number(clientInfo.protocolVersion);
  const min = Number(clientInfo.minProtocolVersion ?? v);
  const max = Number(clientInfo.maxProtocolVersion ?? v);
  if (!Number.isInteger(v) || !Number.isInteger(min) || !Number.isInteger(max)) return { ok: false, code: ERROR_CODES.INCOMPATIBLE_PROTOCOL, message: 'Client protocol is missing or invalid.' };
  if (max < MIN_CLIENT_PROTOCOL) return { ok: false, code: ERROR_CODES.INCOMPATIBLE_PROTOCOL, message: `Client protocol is too old. Please refresh or redeploy the frontend.` };
  if (min > MAX_CLIENT_PROTOCOL) return { ok: false, code: ERROR_CODES.INCOMPATIBLE_PROTOCOL, message: `Client protocol is newer than this server. Please update the backend.` };
  const caps = Array.isArray(clientInfo.capabilities) ? new Set(clientInfo.capabilities.filter((c) => typeof c === 'string')) : new Set();
  for (const cap of REQUIRED_CAPABILITIES) if (!caps.has(cap)) return { ok: false, code: ERROR_CODES.MISSING_CAPABILITY, message: `Client is missing required capability: ${cap}` };
  return { ok: true };
}

function serverEnvelope(client, data = {}) {
  return {
    type: data.type,
    protocolVersion: PROTOCOL_VERSION,
    connectionId: client?.id,
    room: data.room ?? client?.room?.code,
    requestId: data.requestId,
    code: data.code,
    message: data.message,
    serverTimeMs: Date.now(),
    ...data
  };
}

module.exports = { MIN_CLIENT_PROTOCOL, MAX_CLIENT_PROTOCOL, MIN_SERVER_PROTOCOL, MAX_SERVER_PROTOCOL, REQUIRED_CAPABILITIES, OPTIONAL_CAPABILITIES, ERROR_CODES, protocolInfo, negotiate, serverEnvelope };
