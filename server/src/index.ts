'use strict';

import { register } from './register';
import { bootstrap } from './bootstrap';
import { destroy } from './destroy';
import config from './config';
import contentTypes from './content-types';
import routes from './routes';
import controllers from './controllers';
import services from './services';
import policies from './policies';

export default {
  register,
  bootstrap,
  destroy,
  config,
  contentTypes,
  routes,
  controllers,
  services,
  policies,
};
