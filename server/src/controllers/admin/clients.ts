'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseScope } from '../../services/oauth/scopes';

interface AdminUserRow {
  id: number;
  email?: string;
  firstname?: string;
  lastname?: string;
  username?: string;
}

/**
 * Batch-resolve admin user info for both ownerAdminId (consent grantor) and
 * createdByAdminId (table appearance). One DB query feeds both fields. A
 * deleted admin user just shows null on its column.
 */
async function enrichWithUsers(
  strapi: Core.Strapi,
  clients: Array<{ ownerAdminId: string | null; createdByAdminId: string | null }>
): Promise<Array<{ ownerAdmin: AdminUserRow | null; createdByAdmin: AdminUserRow | null }>> {
  const ids = Array.from(
    new Set(
      clients
        .flatMap((c) => [c.ownerAdminId, c.createdByAdminId])
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n))
    )
  );
  if (ids.length === 0) {
    return clients.map(() => ({ ownerAdmin: null, createdByAdmin: null }));
  }
  const users = (await strapi.db
    .query('admin::user')
    .findMany({
      where: { id: { $in: ids } },
      select: ['id', 'email', 'firstname', 'lastname', 'username'],
    })) as AdminUserRow[];
  const byId = new Map(users.map((u) => [String(u.id), u]));
  return clients.map((c) => ({
    ownerAdmin: c.ownerAdminId ? byId.get(c.ownerAdminId) ?? null : null,
    createdByAdmin: c.createdByAdminId ? byId.get(c.createdByAdminId) ?? null : null,
  }));
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async list(ctx: Context): Promise<void> {
    const clients = await strapi.plugin('mcp-server').service('clients').list();
    const enriched = await enrichWithUsers(strapi, clients);
    ctx.body = {
      clients: clients.map((c: Record<string, unknown>, i: number) => ({
        ...c,
        ownerAdmin: enriched[i].ownerAdmin,
        createdByAdmin: enriched[i].createdByAdmin,
      })),
    };
  },

  async create(ctx: Context): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as {
      clientName?: string;
      redirectUris?: string[];
      scopes?: string | string[];
      isConfidential?: boolean;
    };
    if (!body.clientName || !Array.isArray(body.redirectUris)) {
      ctx.status = 400;
      ctx.body = { error: 'missing fields' };
      return;
    }
    const adminUser = ctx.state.user as { id: number | string } | undefined;
    const authCredentials =
      (ctx.state.auth as { credentials?: { id?: number | string } } | undefined)?.credentials;
    // Prefer ctx.state.user; fall back to auth.credentials in case the admin
    // strategy populated only the latter.
    const createdByAdminId =
      adminUser?.id !== undefined
        ? String(adminUser.id)
        : authCredentials?.id !== undefined
          ? String(authCredentials.id)
          : undefined;
    const scopes = parseScope(
      Array.isArray(body.scopes) ? body.scopes.join(' ') : body.scopes ?? ''
    );
    try {
      // ownerAdminId is intentionally not set here — it represents the consent
      // grantor and stays null until the first /oauth/authorize approval.
      const result = await strapi.plugin('mcp-server').service('clients').create({
        clientName: body.clientName,
        redirectUris: body.redirectUris,
        scopes,
        isConfidential: !!body.isConfidential,
        createdByAdminId,
      });
      ctx.body = result; // client_secret returned once
    } catch (err) {
      ctx.status = 400;
      ctx.body = { error: (err as Error).message };
    }
  },

  async update(ctx: Context): Promise<void> {
    const { clientId } = ctx.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.clientName === 'string') patch.clientName = body.clientName;
    if (Array.isArray(body.redirectUris)) patch.redirectUris = body.redirectUris;
    if (typeof body.disabled === 'boolean') patch.disabled = body.disabled;
    if (body.scopes !== undefined) {
      patch.scopes = parseScope(
        Array.isArray(body.scopes) ? body.scopes.join(' ') : String(body.scopes)
      );
    }
    const updated = await strapi.plugin('mcp-server').service('clients').update(clientId, patch);
    if (!updated) ctx.throw(404, 'not found');
    ctx.body = updated;
  },

  async findOne(ctx: Context): Promise<void> {
    const { clientId } = ctx.params;
    const client = await strapi.plugin('mcp-server').service('clients').findActive(clientId);
    if (!client) {
      // findActive only returns enabled clients; fall back to a raw lookup so
      // the admin can see and re-enable disabled clients.
      const row = await strapi.db
        .query('plugin::mcp-server.oauth-client')
        .findOne({ where: { clientId } });
      if (!row) {
        ctx.throw(404, 'not found');
      }
      ctx.body = row;
      return;
    }
    ctx.body = client;
  },

  async destroy(ctx: Context): Promise<void> {
    const { clientId } = ctx.params;
    const deleted = await strapi.plugin('mcp-server').service('clients').delete(clientId);
    if (!deleted) ctx.throw(404, 'not found');
    ctx.status = 204;
  },
});
