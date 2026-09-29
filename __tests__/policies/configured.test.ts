'use strict';

import configured from '../../server/src/policies/configured';
import configModule from '../../server/src/config';
import { makeStrapi } from '../helpers/strapi-mock';

describe('configured policy', () => {
  it('404s every public route while resourceUrl is unset', () => {
    const strapi = makeStrapi({ config: { resourceUrl: '' } });
    expect(() => configured({}, {}, { strapi })).toThrow('Not Found');
  });

  it('passes once resourceUrl is set', () => {
    expect(configured({}, {}, { strapi: makeStrapi() })).toBe(true);
  });
});

describe('config validator', () => {
  it('accepts the unconfigured defaults (installed but inactive)', () => {
    expect(() => configModule.validator(configModule.default)).not.toThrow();
  });

  it('validates fully once resourceUrl is set', () => {
    expect(() =>
      configModule.validator({ ...configModule.default, resourceUrl: 'http://localhost:1337/mcp' })
    ).toThrow(/allowedOrigins/);
  });
});
