'use strict';

import { createHash, randomBytes } from 'crypto';
import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

const UID = 'plugin::mcp-server.upload-ticket';

export interface UploadTicketRow {
  id: number;
  adminUserId: string;
  clientId: string;
  folderId: number | null;
  alternativeText: string | null;
  caption: string | null;
  used: boolean;
  expiresAt: string;
}

/**
 * One-time upload URLs. The ticket is a bearer capability the model can see
 * and pass to `curl`, so it is single-use, short-lived, bound to the admin +
 * client that asked for it, and stored only as a hash.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  return {
    async issue(input: {
      adminUserId: string;
      clientId: string;
      folderId?: number;
      alternativeText?: string;
      caption?: string;
    }): Promise<{ ticket: string; expiresAt: Date }> {
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + getConfig(strapi).upload.ticketTtlSec * 1000);
      await strapi.db.query(UID).create({
        data: {
          ticketHash: sha256(ticket),
          adminUserId: input.adminUserId,
          clientId: input.clientId,
          folderId: input.folderId ?? null,
          alternativeText: input.alternativeText ?? null,
          caption: input.caption ?? null,
          used: false,
          expiresAt,
        },
      });
      return { ticket, expiresAt };
    },

    /** Look up without consuming — used to render the browser form. */
    async peek(ticket: string): Promise<UploadTicketRow | 'gone' | null> {
      const row = (await strapi.db
        .query(UID)
        .findOne({ where: { ticketHash: sha256(ticket) } })) as UploadTicketRow | null;
      if (!row) return null;
      if (row.used || new Date(row.expiresAt).getTime() < Date.now()) return 'gone';
      return row;
    },

    /**
     * Atomically consume. Returns the row if this caller won, 'gone' if it was
     * already used or has expired, null if unknown. Consumed on the first
     * attempt even if the upload then fails — the agent just asks again.
     */
    async claim(ticket: string): Promise<UploadTicketRow | 'gone' | null> {
      const row = await this.peek(ticket);
      if (!row || row === 'gone') return row;
      const { count } = await strapi.db.query(UID).updateMany({
        where: { id: row.id, used: false },
        data: { used: true },
      });
      return count === 1 ? { ...row, used: true } : 'gone';
    },

    async purgeExpired(): Promise<void> {
      await strapi.db.query(UID).deleteMany({ where: { expiresAt: { $lt: new Date() } } });
    },
  };
};
