'use strict';

import type { Core } from '@strapi/strapi';
import type { ContentChecker, PrincipalContext } from '../permissions';

type Attr = {
  type: string;
  target?: string;
  component?: string;
  components?: string[];
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/**
 * Strapi's admin output sanitizer only applies the *root* content type's
 * permissions: a populated relation comes back whole even when the caller
 * cannot read the target type (the Content Manager itself never populates
 * relations like that — its relations endpoint returns just ids + main field).
 *
 * This walks every populated relation (inside components and dynamic zones
 * too) and re-checks each related entry against its *own* type:
 *   - readable (including conditions such as "is creator") → sanitized with
 *     the target type's field permissions, and walked recursively;
 *   - not readable → reduced to `{ documentId }`.
 *
 * Relations to admin users are left to Strapi's own admin-user field picker;
 * relations to other plugin-internal types are always reduced.
 */
export function createRelationGuard(strapi: Core.Strapi, principal: PrincipalContext) {
  const perms = strapi.plugin('mcp-server').service('permissions');
  const checkers = new Map<string, Promise<ContentChecker | null>>();

  const checkerFor = (uid: string): Promise<ContentChecker | null> => {
    if (!checkers.has(uid)) {
      checkers.set(
        uid,
        perms.isInternalUid(uid) ? Promise.resolve(null) : perms.contentChecker(principal, uid)
      );
    }
    return checkers.get(uid)!;
  };

  const attributesOf = (uid: string): Record<string, Attr> =>
    (
      (strapi.contentTypes as unknown as Record<string, { attributes: Record<string, Attr> }>)[
        uid
      ] ??
      (strapi.components as unknown as Record<string, { attributes: Record<string, Attr> }>)[uid]
    )?.attributes ?? {};

  /**
   * Which of `entities` the caller may read. With conditions, ask the DB
   * using the role's own permission filters (the entities as populated don't
   * carry what the conditions need); also returns those condition fields so
   * sanitizeOutput can evaluate field permissions.
   */
  async function readable(
    c: ContentChecker,
    uid: string,
    entities: Doc[]
  ): Promise<Map<unknown, Doc> | 'all'> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requiresEntity = (c as any).requiresEntity?.read?.() ?? true;
    if (!requiresEntity) return 'all';
    const q = await c.sanitizedQuery.read({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const populateBuilder = strapi.plugin('content-manager').service('populate-builder') as any;
    const populate = (await populateBuilder(uid).populateFromQuery(q).build()) ?? {};
    const ids = entities.map((e) => e.id).filter((id) => id !== undefined);
    if (ids.length === 0) return new Map();
    const rows = (await strapi.db.query(uid as never).findMany({
      where: { $and: [q.filters ?? {}, { id: { $in: ids } }] },
      populate,
    })) as Doc[];
    return new Map(rows.map((r) => [r.id, r]));
  }

  async function guardRelated(uid: string, entities: Doc[]): Promise<Doc[]> {
    const c = uid === 'admin::user' ? undefined : await checkerFor(uid);
    if (c === undefined) return entities; // admin users: Strapi's picker already applied
    if (!c || c.cannot.read()) return entities.map((e) => ({ documentId: e.documentId }));
    const allowed = await readable(c, uid, entities);
    return Promise.all(
      entities.map(async (e) => {
        const conditionFields = allowed === 'all' ? {} : allowed.get(e.id);
        if (allowed !== 'all' && !conditionFields) return { documentId: e.documentId };
        // Evaluate field permissions with the condition relations present,
        // then drop anything the caller didn't populate themselves.
        const extra = Object.keys(conditionFields ?? {}).filter((k) => !(k in e));
        const sanitized: Doc = await c.sanitizeOutput({ ...conditionFields, ...e });
        for (const k of extra) delete sanitized[k];
        return walk(uid, sanitized);
      })
    );
  }

  async function walk(uid: string, doc: Doc): Promise<Doc> {
    if (!doc || typeof doc !== 'object') return doc;
    const out: Doc = { ...doc };
    for (const [name, attr] of Object.entries(attributesOf(uid))) {
      const value = out[name];
      if (value === undefined || value === null) continue;
      if (attr.type === 'relation' && attr.target) {
        const list = Array.isArray(value) ? value : [value];
        // `count` populates come back as { count } — nothing to guard.
        if (list.some((v) => typeof v !== 'object' || !('id' in v || 'documentId' in v))) continue;
        // eslint-disable-next-line no-await-in-loop
        const guarded = await guardRelated(attr.target, list);
        out[name] = Array.isArray(value) ? guarded : guarded[0];
      } else if (attr.type === 'component' && attr.component) {
        const list = Array.isArray(value) ? value : [value];
        // eslint-disable-next-line no-await-in-loop
        const walked = await Promise.all(list.map((v) => walk(attr.component!, v)));
        out[name] = Array.isArray(value) ? walked : walked[0];
      } else if (attr.type === 'dynamiczone' && Array.isArray(value)) {
        // eslint-disable-next-line no-await-in-loop
        out[name] = await Promise.all(
          value.map((v: Doc) => (v?.__component ? walk(v.__component, v) : v))
        );
      }
    }
    return out;
  }

  return {
    /** Guard all populated relations of an already-sanitized root entry. */
    apply: (uid: string, doc: Doc | null): Promise<Doc | null> =>
      doc ? walk(uid, doc) : Promise.resolve(doc),
  };
}
