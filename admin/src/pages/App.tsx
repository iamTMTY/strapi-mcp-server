import { Routes, Route, Navigate } from 'react-router-dom';
import { Box, Flex } from '@strapi/design-system';
import { useAuth } from '@strapi/strapi/admin';
import { Sidebar } from '../components/Sidebar';
import { HomePage } from './HomePage';
import { Clients } from './Clients';
import { NewClient } from './NewClient';
import { EditClient } from './EditClient';
import { Tools } from './Tools';
import { AuditLog } from './AuditLog';
import { Settings } from './Settings';
import { SsoBridge } from './SsoBridge';

interface UserPermission {
  action: string;
  subject: string | null;
}

const ACTION_READ = 'plugin::mcp-server.read';
const ACTION_AUDIT = 'plugin::mcp-server.audit.read';
const ACTION_CLIENTS = 'plugin::mcp-server.clients.manage';

function useUserPermissions(): UserPermission[] {
  return (
    useAuth('mcp-server', (s: { permissions?: UserPermission[] }) => s?.permissions) ?? []
  );
}

/**
 * Wrap a route with a permission check. If the user lacks the action, redirect
 * to the plugin's index (which itself redirects to the user's landing page).
 * The Sidebar already hides the menu entry — this catches direct URL access.
 */
function Protected({
  action,
  children,
}: {
  action: string;
  children: JSX.Element;
}): JSX.Element {
  const userPermissions = useUserPermissions();
  const hasAccess = userPermissions.some((p) => p.action === action);
  if (!hasAccess) return <Navigate to="" replace />;
  return children;
}

/**
 * Index route. The plugin's Overview page requires `read`; a user who only
 * has `audit.read` or `clients.manage` should land on the page they CAN see
 * instead of getting a "Failed: Policy Failed" error on the dashboard.
 */
function IndexRoute(): JSX.Element {
  const userPermissions = useUserPermissions();
  const has = (a: string): boolean => userPermissions.some((p) => p.action === a);
  if (has(ACTION_READ)) return <HomePage />;
  if (has(ACTION_CLIENTS)) return <Navigate to="clients" replace />;
  if (has(ACTION_AUDIT)) return <Navigate to="audit" replace />;
  // No MCP permission at all — Strapi shouldn't have routed them here, but
  // belt-and-suspenders, push them back to the admin home.
  return <Navigate to="/" replace />;
}

export function App(): JSX.Element {
  return (
    <Flex alignItems="stretch" minHeight="100vh">
      <Sidebar />
      <Box flex={1} padding={10} background="neutral100" overflow="auto">
        <Routes>
          <Route index element={<IndexRoute />} />
          <Route
            path="clients"
            element={
              <Protected action={ACTION_CLIENTS}>
                <Clients />
              </Protected>
            }
          />
          <Route
            path="clients/new"
            element={
              <Protected action={ACTION_CLIENTS}>
                <NewClient />
              </Protected>
            }
          />
          <Route
            path="clients/:clientId/edit"
            element={
              <Protected action={ACTION_CLIENTS}>
                <EditClient />
              </Protected>
            }
          />
          <Route
            path="tools"
            element={
              <Protected action={ACTION_READ}>
                <Tools />
              </Protected>
            }
          />
          <Route
            path="audit"
            element={
              <Protected action={ACTION_AUDIT}>
                <AuditLog />
              </Protected>
            }
          />
          <Route
            path="settings"
            element={
              <Protected action={ACTION_READ}>
                <Settings />
              </Protected>
            }
          />
          <Route path="sso-bridge" element={<SsoBridge />} />
          <Route path="*" element={<Navigate to="" replace />} />
        </Routes>
      </Box>
    </Flex>
  );
}

export default App;
