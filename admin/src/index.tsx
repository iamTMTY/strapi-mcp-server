import { Cog as PluginIcon } from '@strapi/icons';
import { PLUGIN_ID } from './pluginId';

const name = 'MCP Server';

export default {
  register(app: {
    addMenuLink: (opts: Record<string, unknown>) => void;
    createSettingSection?: (opts: Record<string, unknown>, links: unknown[]) => void;
    registerPlugin: (plugin: Record<string, unknown>) => void;
  }): void {
    app.addMenuLink({
      to: `/plugins/${PLUGIN_ID}`,
      icon: PluginIcon,
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: name },
      Component: async () => {
        const { App } = await import('./pages/App');
        return { default: App };
      },
      // Permissions array is OR-matched: any one of these grants the menu
      // entry. An audit-only user still sees the icon (and lands on the
      // Audit Log page).
      permissions: [
        { action: `plugin::${PLUGIN_ID}.read`, subject: null },
        { action: `plugin::${PLUGIN_ID}.audit.read`, subject: null },
        { action: `plugin::${PLUGIN_ID}.clients.manage`, subject: null },
      ],
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: () => null,
      isReady: true,
      name,
    });
  },

  bootstrap(): void {
    /* no-op */
  },

  async registerTrads({ locales }: { locales: string[] }): Promise<unknown[]> {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);
          return { data, locale };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};
