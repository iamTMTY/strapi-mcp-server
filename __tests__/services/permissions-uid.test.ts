'use strict';

import permissionsFactory from '../../server/src/services/permissions';
import { makeStrapi } from '../helpers/strapi-mock';

const svc = permissionsFactory({
  strapi: makeStrapi({
    contentTypes: {
      'api::article.article': { kind: 'collectionType' },
      'api::page.page': { kind: 'singleType' },
      'api::component.thing': { kind: 'component' }, // should be excluded
      'admin::user': { kind: 'collectionType' },
      'strapi::core-store': { kind: 'collectionType' },
      'plugin::users-permissions.role': { kind: 'collectionType' },
      'plugin::users-permissions.permission': { kind: 'collectionType' },
      'plugin::i18n.locale': { kind: 'collectionType' },
      'plugin::upload.file': { kind: 'collectionType' },
      'plugin::upload.folder': { kind: 'collectionType' },
      'plugin::mcp-server.oauth-client': { kind: 'collectionType' },
    },
  }),
});

describe('permissions.isInternalUid', () => {
  it('blocks admin::*', () => {
    expect(svc.isInternalUid('admin::user')).toBe(true);
    expect(svc.isInternalUid('admin::role')).toBe(true);
  });

  it('blocks strapi::*', () => {
    expect(svc.isInternalUid('strapi::core-store')).toBe(true);
  });

  it('blocks users-permissions role / permission specifically', () => {
    expect(svc.isInternalUid('plugin::users-permissions.role')).toBe(true);
    expect(svc.isInternalUid('plugin::users-permissions.permission')).toBe(true);
  });

  it('blocks i18n locale', () => {
    expect(svc.isInternalUid('plugin::i18n.locale')).toBe(true);
  });

  it('blocks upload file/folder', () => {
    expect(svc.isInternalUid('plugin::upload.file')).toBe(true);
    expect(svc.isInternalUid('plugin::upload.folder')).toBe(true);
  });

  it('blocks any plugin::mcp-server.* content-type', () => {
    expect(svc.isInternalUid('plugin::mcp-server.oauth-client')).toBe(true);
    expect(svc.isInternalUid('plugin::mcp-server.audit-log')).toBe(true);
  });

  it('allows api::* content-types', () => {
    expect(svc.isInternalUid('api::article.article')).toBe(false);
    expect(svc.isInternalUid('api::page.page')).toBe(false);
  });
});

describe('permissions.listAllowedUids', () => {
  it('returns only collection + single types, filtering internal', () => {
    const out = svc.listAllowedUids().sort();
    expect(out).toEqual(['api::article.article', 'api::page.page']);
  });
});

describe('permissions.canActionOnUid', () => {
  const principalAdmin = {
    user: { id: 1, isActive: true },
    permissions: [
      { action: 'plugin::content-manager.explorer.read', subject: 'api::article.article' },
      { action: 'plugin::content-manager.explorer.create', subject: null }, // wildcard
    ],
    isSuperAdmin: false,
  };
  const principalSuper = { ...principalAdmin, isSuperAdmin: true, permissions: [] };

  it('always denies internal UIDs even for super-admin', async () => {
    expect(await svc.canActionOnUid(principalSuper, 'admin::user', 'read')).toBe(false);
    expect(await svc.canActionOnUid(principalSuper, 'plugin::mcp-server.oauth-client', 'read')).toBe(false);
  });

  it('super-admin allowed on regular UIDs', async () => {
    expect(await svc.canActionOnUid(principalSuper, 'api::article.article', 'update')).toBe(true);
    expect(await svc.canActionOnUid(principalSuper, 'api::page.page', 'delete')).toBe(true);
  });

  it('matches subject-specific permission', async () => {
    expect(await svc.canActionOnUid(principalAdmin, 'api::article.article', 'read')).toBe(true);
  });

  it('rejects when subject doesnt match', async () => {
    expect(await svc.canActionOnUid(principalAdmin, 'api::page.page', 'read')).toBe(false);
  });

  it('accepts wildcard subject (subject: null)', async () => {
    expect(await svc.canActionOnUid(principalAdmin, 'api::page.page', 'create')).toBe(true);
  });

  it('rejects an action not granted', async () => {
    expect(await svc.canActionOnUid(principalAdmin, 'api::article.article', 'delete')).toBe(false);
  });
});
