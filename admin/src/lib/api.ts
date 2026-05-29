import { useFetchClient } from '@strapi/strapi/admin';
import { PLUGIN_ID } from '../pluginId';

// Strapi mounts plugin admin routes at `/<plugin-name>/<path>` at the host root
// (no `/api` or `/admin` prefix). useFetchClient handles the admin JWT, base
// URL, and error normalization for us.
const base = `/${PLUGIN_ID}`;

export function useMcpApi() {
  const { get, post, put, del } = useFetchClient();
  return {
    overview: async () => (await get(`${base}/dashboard`)).data,
    listClients: async () => (await get(`${base}/clients`)).data,
    getClient: async (clientId: string) =>
      (await get(`${base}/clients/${clientId}`)).data,
    createClient: async (body: Record<string, unknown>) =>
      (await post(`${base}/clients`, body)).data,
    updateClient: async (clientId: string, body: Record<string, unknown>) =>
      (await put(`${base}/clients/${clientId}`, body)).data,
    deleteClient: async (clientId: string) =>
      (await del(`${base}/clients/${clientId}`)).data,
    listAudit: async (params: Record<string, string | number> = {}) =>
      (await get(`${base}/audit`, { params })).data,
    settings: async () => (await get(`${base}/settings`)).data,
    tools: async () => (await get(`${base}/tools`)).data,
  };
}
