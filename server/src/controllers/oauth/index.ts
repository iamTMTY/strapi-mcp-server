'use strict';

import metadata from './metadata';
import authorize from './authorize';
import token from './token';
import introspect from './introspect';
import dcrRegister from './register';

export default {
  metadata,
  authorize,
  token,
  introspect,
  'dcr-register': dcrRegister,
};
