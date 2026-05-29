'use strict';

import audit from './audit';
import rateLimiter from './rate-limiter';
import permissions from './permissions';
import sessionStore from './session-store';
import sessionDirectory from './session-directory';
import mcpServerFactory from './mcp-server';
import ssoCookie from './sso-cookie';
import redis from './redis';
import instanceId from './instance-id';
import proxyClient from './proxy-client';
import heartbeat from './heartbeat';
import signingKeys from './oauth/signing-keys';
import tokens from './oauth/tokens';
import consent from './oauth/consent';
import clients from './oauth/clients';
import authCodes from './oauth/auth-codes';

export default {
  audit,
  'rate-limiter': rateLimiter,
  permissions,
  'session-store': sessionStore,
  'session-directory': sessionDirectory,
  'mcp-server': mcpServerFactory,
  'sso-cookie': ssoCookie,
  redis,
  'instance-id': instanceId,
  'proxy-client': proxyClient,
  heartbeat,
  'signing-keys': signingKeys,
  tokens,
  consent,
  clients,
  'auth-codes': authCodes,
};
