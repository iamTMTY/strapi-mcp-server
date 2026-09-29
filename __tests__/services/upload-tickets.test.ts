'use strict';

import ticketsFactory from '../../server/src/services/upload-tickets';
import { makeStrapi, mockQuery } from '../helpers/strapi-mock';

function setup() {
  const rows: Array<Record<string, unknown>> = [];
  const query = mockQuery({
    create: jest.fn(async ({ data }) => {
      const row = { id: rows.length + 1, ...data };
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(
      async ({ where }) => rows.find((r) => r.ticketHash === where.ticketHash) ?? null
    ),
    updateMany: jest.fn(async ({ where, data }) => {
      await Promise.resolve(); // let concurrent claims interleave
      const hits = rows.filter((r) => r.id === where.id && r.used === where.used);
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }),
  });
  const strapi = makeStrapi({ query: { 'plugin::mcp-server.upload-ticket': query } });
  return { svc: ticketsFactory({ strapi }), rows };
}

const input = { adminUserId: '1', clientId: 'cid', folderId: 3, caption: 'c' };

describe('upload-tickets', () => {
  it('stores only a hash of the ticket', async () => {
    const { svc, rows } = setup();
    const { ticket } = await svc.issue(input);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(rows)).not.toContain(ticket);
  });

  it('is single use, even under concurrent claims', async () => {
    const { svc } = setup();
    const { ticket } = await svc.issue(input);
    const results = await Promise.all([svc.claim(ticket), svc.claim(ticket)]);
    expect(results.filter((r) => r && r !== 'gone')).toHaveLength(1);
    expect(await svc.claim(ticket)).toBe('gone');
  });

  it('carries the metadata bound at issue time', async () => {
    const { svc } = setup();
    const { ticket } = await svc.issue(input);
    expect(await svc.claim(ticket)).toMatchObject({
      adminUserId: '1',
      clientId: 'cid',
      folderId: 3,
      caption: 'c',
    });
  });

  it('treats expired tickets as gone and unknown ones as null', async () => {
    const { svc, rows } = setup();
    const { ticket } = await svc.issue(input);
    rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await svc.claim(ticket)).toBe('gone');
    expect(await svc.claim('nope')).toBeNull();
  });
});
