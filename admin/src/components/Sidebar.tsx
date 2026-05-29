import { NavLink } from 'react-router-dom';
import styled from 'styled-components';
import { Box, Divider, Flex, Typography } from '@strapi/design-system';
import { useAuth } from '@strapi/strapi/admin';

interface UserPermission {
  action: string;
  subject: string | null;
}

/**
 * Mirrors `@strapi/admin/src/components/SubNav` (the component Strapi's own
 * settings sidebar is built from) so MCP looks like first-class admin chrome
 * rather than a custom plugin pane.
 *
 * Key bits ported verbatim from Strapi:
 *  - neutral0 surface, 23.2rem wide, 5.6rem-tall header
 *  - Typography wraps each link label (proper font/line-height inherited)
 *  - active state lives on `.active > div`, applying primary100 bg + primary700 text
 */

const SidebarRoot = styled.nav`
  flex-shrink: 0;
  width: 23.2rem;
  background: ${({ theme }) => theme.colors.neutral0};
  border-right: 1px solid ${({ theme }) => theme.colors.neutral150};
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
`;

const HeaderRow = styled(Flex)`
  flex: 0 0 5.6rem;
  height: 5.6rem;
`;

const ItemLink = styled(NavLink)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-decoration: none;
  height: 32px;
  color: ${({ theme }) => theme.colors.neutral800};

  &.active > div {
    background-color: ${({ theme }) => theme.colors.primary100};
    color: ${({ theme }) => theme.colors.primary700};
    font-weight: 500;
  }

  &:hover.active > div {
    background-color: ${({ theme }) => theme.colors.primary100};
  }

  &:hover > div {
    background-color: ${({ theme }) => theme.colors.neutral100};
  }

  &:focus-visible {
    outline-offset: -2px;
  }
`;

interface ItemProps {
  to: string;
  end?: boolean;
  children: React.ReactNode;
}

function Item({ to, end, children }: ItemProps): JSX.Element {
  return (
    <ItemLink to={to} end={end}>
      <Box width="100%" paddingLeft={3} paddingRight={3} borderRadius={1}>
        <Typography tag="div" style={{ lineHeight: '32px' }}>
          {children}
        </Typography>
      </Box>
    </ItemLink>
  );
}

export function Sidebar(): JSX.Element {
  // Read permissions directly from the auth context to sidestep useRBAC's
  // known timing issue (strapi/strapi#24384). The plugin top-level menu link
  // already gates entry on `plugin::mcp-server.read`, so anyone reaching this
  // sidebar has at least Read MCP dashboard.
  const userPermissions =
    (useAuth('Sidebar', (s: { permissions?: UserPermission[] }) => s?.permissions) ?? []);
  const can = (action: string): boolean =>
    userPermissions.some((p) => p.action === action);
  const canRead = can('plugin::mcp-server.read');
  const canManageClients = can('plugin::mcp-server.clients.manage');
  const canReadAudit = can('plugin::mcp-server.audit.read');

  return (
    <SidebarRoot aria-label="MCP Server navigation">
      <HeaderRow justifyContent="flex-start" alignItems="center" paddingLeft={5} paddingRight={5}>
        <Typography variant="beta" tag="h2">
          MCP Server
        </Typography>
      </HeaderRow>
      <Divider />
      <Box paddingTop={4} paddingBottom={4} paddingLeft={2} paddingRight={2}>
        <Flex tag="ul" direction="column" alignItems="stretch" gap="2px">
          {canRead && (
            <li>
              <Item to="" end>
                Overview
              </Item>
            </li>
          )}
          {canManageClients && (
            <li>
              <Item to="clients">Clients</Item>
            </li>
          )}
          {canRead && (
            <li>
              <Item to="tools">Tools</Item>
            </li>
          )}
          {canReadAudit && (
            <li>
              <Item to="audit">Audit Log</Item>
            </li>
          )}
          {canRead && (
            <li>
              <Item to="settings">Settings</Item>
            </li>
          )}
        </Flex>
      </Box>
    </SidebarRoot>
  );
}
