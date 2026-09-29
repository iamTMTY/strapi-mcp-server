'use strict';

import { createMediaTools } from '../../../server/src/services/tools/media';
import { makeStrapi } from '../../helpers/strapi-mock';

/**
 * delete_folder must delete exactly the files it checked. A file that lands
 * in the folder after the permission scan (concurrent upload / move) must
 * survive, and so must the folder holding it.
 */
function setup(opts: { arrivesDuringDelete: boolean; ownOnly?: boolean }) {
  const folder = { id: 5, name: 'f', path: '/5' };
  let files = [{ id: 1, name: 'mine.png', folderPath: '/5', createdBy: { id: 7 } }];
  const removed: number[] = [];
  const folderDeleteMany = jest.fn(async () => ({ count: 1 }));
  const eventHub = { emit: jest.fn() };

  const pm = {
    isAllowed: true,
    action: 'plugin::upload.assets.update',
    // "own files only" when ownOnly: creator must be user 7
    ability: {
      cannot: (_a: string, subject: { createdBy?: { id: number } | null }) =>
        !!opts.ownOnly && subject.createdBy?.id !== 7,
      rulesFor: () => (opts.ownOnly ? [{ conditions: { 'createdBy.id': 7 } }] : [{}]),
    },
    toSubject: (x: unknown) => x,
  };
  const strapi = makeStrapi({ services: { permissions: { uploadManager: async () => pm } } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = strapi as any;
  s.eventHub = eventHub;
  s.db.query = jest.fn((uid: string) => {
    if (uid === 'plugin::upload.folder') {
      return {
        findMany: async () => [folder],
        count: async () => 1,
        deleteMany: folderDeleteMany,
      };
    }
    if (uid === 'plugin::upload.file') {
      return {
        findMany: async () => files.map((f) => ({ ...f })),
        count: async () => files.length,
      };
    }
    // admin::user lookups for creator conditions
    return {
      findOne: async ({ where }: { where: { id: number } }) => ({ id: where.id, roles: [] }),
    };
  });
  const uploadSvc = {
    remove: jest.fn(async (f: { id: number }) => {
      removed.push(f.id);
      files = files.filter((x) => x.id !== f.id);
      // Someone else's file is uploaded into the folder mid-delete.
      if (opts.arrivesDuringDelete && f.id === 1) {
        files.push({ id: 99, name: 'theirs.png', folderPath: '/5', createdBy: { id: 8 } });
      }
    }),
  };
  const basePlugin = s.plugin;
  s.plugin = jest.fn((name: string) =>
    name === 'upload' ? { service: () => uploadSvc } : basePlugin(name)
  );
  const tool = createMediaTools(strapi).find((t) => t.name === 'strapi_media_delete_folder')!;
  const auth = {
    clientId: 'c',
    principal: { user: { id: 7 }, isSuperAdmin: false },
    scopes: ['strapi:media:delete'],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async () =>
    JSON.parse((await tool.handler({ ids: [5] }, auth as any)).content[0].text);
  return { run, removed, folderDeleteMany, eventHub };
}

describe('strapi_media_delete_folder', () => {
  it('deletes the checked files, then the folder', async () => {
    const { run, removed, folderDeleteMany, eventHub } = setup({
      arrivesDuringDelete: false,
      ownOnly: true,
    });
    const out = await run();
    expect(removed).toEqual([1]);
    expect(folderDeleteMany).toHaveBeenCalled();
    expect(eventHub.emit).toHaveBeenCalledWith('media-folder.delete', expect.anything());
    expect(out).toMatchObject({ totalFolderNumber: 1, totalFileNumber: 1 });
  });

  it('never deletes a file that arrived after the check, and keeps its folder', async () => {
    const { run, removed, folderDeleteMany } = setup({ arrivesDuringDelete: true, ownOnly: true });
    const out = await run();
    expect(removed).toEqual([1]); // not 99
    expect(folderDeleteMany).not.toHaveBeenCalled();
    expect(out.keptFolders).toEqual([{ id: 5, name: 'f' }]);
    expect(out.note).toMatch(/1 file\(s\) were added/);
  });
});
