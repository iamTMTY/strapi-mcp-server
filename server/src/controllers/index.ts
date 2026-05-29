'use strict';

import mcp from './mcp';
import oauth from './oauth';
import admin from './admin';
import proxy from './proxy';

export default {
  mcp,
  proxy,
  ...oauth,
  ...admin,
};
