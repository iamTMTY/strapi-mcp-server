'use strict';

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { getConfig, isConfigured } from '../config';

/**
 * First policy on every public plugin route (/mcp, /oauth/*, /.well-known/*,
 * cluster proxy): an installed-but-unconfigured plugin serves nothing.
 */
export default (_ctx: unknown, _cfg: unknown, { strapi }: { strapi: Core.Strapi }): boolean => {
  if (!isConfigured(getConfig(strapi))) throw new errors.NotFoundError('Not Found');
  return true;
};
