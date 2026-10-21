// A host's public name. Host.displayName is a Mongoose virtual computed from other fields, so it
// only exists on full (non-lean) documents that loaded those fields; compute it from raw fields.
const HOST_NAME_FIELDS = 'userType firstName lastName organizationName';

function hostDisplayName(host) {
  if (!host) return '';
  const person = [host.firstName, host.lastName].filter(Boolean).join(' ').trim();
  const org = (host.organizationName || '').trim();
  const name = host.userType === 'organization' ? org || person : person || org;
  return name || '';
}

module.exports = { hostDisplayName, HOST_NAME_FIELDS };
