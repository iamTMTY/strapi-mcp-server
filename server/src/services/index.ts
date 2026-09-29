'use strict';

import audit from './audit';
import rateLimiter from './rate-limiter';
import permissions from './permissions';
import mcpServerFactory from './mcp-server';
import ssoCookie from './sso-cookie';
import redis from './redis';
import signingKeys from './oauth/signing-keys';
import tokens from './oauth/tokens';
import consent from './oauth/consent';
import clients from './oauth/clients';
import authCodes from './oauth/auth-codes';
import uploadTickets from './upload-tickets';
import toolRegistry from './tool-registry';

export default {
  audit,
  'rate-limiter': rateLimiter,
  permissions,
  'mcp-server': mcpServerFactory,
  'sso-cookie': ssoCookie,
  redis,
  'signing-keys': signingKeys,
  tokens,
  consent,
  clients,
  'auth-codes': authCodes,
  'upload-tickets': uploadTickets,
  'tool-registry': toolRegistry,
};
