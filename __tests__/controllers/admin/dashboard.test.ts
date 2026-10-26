'use strict';

import dashboardFactory from '../../../server/src/controllers/admin/dashboard';
import { makeStrapi } from '../../helpers/strapi-mock';

function run(allowed: string[]) {
  const row = {
    tool: 'strapi_content_update_entry',
    params: { data: { body: 'draft' } },
    ip: '203.0.113.9',
  };
  const recent = jest.fn(async () => [row]);
  const strapi = makeStrapi({
    config: { resourceUrl: 'http://localhost:1337/mcp' },
    services: {
      audit: {
        recent,
        enrich: async (rows: unknown[]) => rows.map(() => ({ principalAdmin: null, client: null })),
      },
    },
  });
  const ctx = {
    state: { userAbility: { can: (action: string) => allowed.includes(action) } },
    body: undefined as unknown as { recentCalls: unknown },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dashboardFactory({ strapi })
    .overview(ctx as any)
    .then(() => ({ body: ctx.body, recent }));
}

describe('dashboard.overview', () => {
  it('withholds audit rows from admins without audit.read', async () => {
    const { body, recent } = await run(['plugin::mcp-server.read']);
    expect(body.recentCalls).toBeNull();
    expect(recent).not.toHaveBeenCalled();
  });

  it('includes them with audit.read', async () => {
    const { body } = await run(['plugin::mcp-server.read', 'plugin::mcp-server.audit.read']);
    expect(body.recentCalls).toHaveLength(1);
  });
});
