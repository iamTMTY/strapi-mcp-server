'use strict';

import auditLog from './audit-log';
import oauthClient from './oauth-client';
import oauthAuthCode from './oauth-auth-code';
import oauthRefreshToken from './oauth-refresh-token';
import oauthRevocation from './oauth-revocation';
import oauthConsent from './oauth-consent';
import oauthSigningKey from './oauth-signing-key';

export default {
  'audit-log': auditLog,
  'oauth-client': oauthClient,
  'oauth-auth-code': oauthAuthCode,
  'oauth-refresh-token': oauthRefreshToken,
  'oauth-revocation': oauthRevocation,
  'oauth-consent': oauthConsent,
  'oauth-signing-key': oauthSigningKey,
};
