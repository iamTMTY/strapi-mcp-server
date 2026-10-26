'use strict';

import { createRelationGuard } from '../../../server/src/services/tools/relation-guard';
import { makeStrapi } from '../../helpers/strapi-mock';

const checker = (canRead: boolean) => ({
  cannot: { read: () => !canRead },
  requiresEntity: { read: () => false },
  sanitizeOutput: async (d: Record<string, unknown>) => ({ ...d, sanitized: true }),
});

function setup(readable: Record<string, boolean>) {
  const strapi = makeStrapi({
    contentTypes: {
      'api::page.page': {
        attributes: {
          hero: { type: 'component', component: 'shared.hero' },
          blocks: { type: 'dynamiczone', components: ['blocks.cta'] },
          author: { type: 'relation', target: 'api::author.author' },
          cover: { type: 'media' },
          gallery: { type: 'media', multiple: true },
        },
      },
      'api::author.author': { attributes: {} },
      'api::secret.secret': { attributes: {} },
    } as never,
    services: {
      permissions: {
        isInternalUid: (uid: string) => uid.startsWith('plugin::'),
        contentChecker: async (_p: unknown, uid: string) => checker(!!readable[uid]),
      },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strapi as any).components = {
    'shared.hero': { attributes: { link: { type: 'relation', target: 'api::secret.secret' } } },
    'blocks.cta': { attributes: { target: { type: 'relation', target: 'api::secret.secret' } } },
  };
  return createRelationGuard(strapi, { user: { id: 1 }, isSuperAdmin: false });
}

describe('relation guard', () => {
  it('reduces unreadable relations everywhere — top level, components, dynamic zones', async () => {
    const guard = setup({ 'api::author.author': true, 'api::secret.secret': false });
    const out = await guard.apply('api::page.page', {
      author: { id: 1, documentId: 'a1', name: 'Ann' },
      hero: { link: { id: 2, documentId: 's1', secret: 'x' } },
      blocks: [{ __component: 'blocks.cta', target: [{ id: 3, documentId: 's2', secret: 'y' }] }],
    });
    expect(out).toEqual({
      author: { id: 1, documentId: 'a1', name: 'Ann', sanitized: true },
      hero: { link: { documentId: 's1' } },
      blocks: [{ __component: 'blocks.cta', target: [{ documentId: 's2' }] }],
    });
  });

  it("strips a media file's own relations (related, folder)", async () => {
    const guard = setup({ 'api::secret.secret': false });
    const file = {
      id: 9,
      name: 'a.png',
      related: [{ id: 5, secret: 'x', __type: 'api::secret.secret' }],
      folder: { id: 1 },
    };
    expect(await guard.apply('api::page.page', { cover: file, gallery: [file] })).toEqual({
      cover: { id: 9, name: 'a.png' },
      gallery: [{ id: 9, name: 'a.png' }],
    });
  });

  it('leaves relation counts alone', async () => {
    const guard = setup({});
    expect(await guard.apply('api::page.page', { author: { count: 3 } })).toEqual({
      author: { count: 3 },
    });
  });
});
