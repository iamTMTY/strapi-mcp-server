import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  IconButton,
  Modal,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { Eye } from '@strapi/icons';
import { useMcpApi } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

interface PrincipalAdmin {
  id: number;
  email?: string;
  firstname?: string;
  lastname?: string;
  username?: string;
}

interface AuditClient {
  clientId: string;
  clientName: string;
}

interface RecentCall {
  ts: string;
  principalType?: string;
  principalId: string;
  principalAdmin?: PrincipalAdmin | null;
  sessionId?: string | null;
  clientId?: string | null;
  client?: AuditClient | null;
  tool: string;
  params?: unknown;
  resultStatus: 'ok' | 'error';
  errorCode?: string | null;
  durationMs?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

interface Overview {
  enabled: boolean;
  resourceUrl: string;
  allowedOrigins: string[];
  sessions: { total: number; byPrincipal: Record<string, number> };
  recentCalls: RecentCall[];
  oauth: { mode: string; dcrEnabled: boolean };
}

function formatPrincipal(admin: PrincipalAdmin | null | undefined, fallbackId: string): string {
  if (!admin) return fallbackId ? `#${fallbackId}` : '—';
  const name = [admin.firstname, admin.lastname].filter(Boolean).join(' ').trim();
  return name || admin.email || admin.username || `#${admin.id}`;
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
      <Box paddingBottom={4}>
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <Box>
      <Typography variant="sigma" textColor="neutral600">
        {label}
      </Typography>
      <Box paddingTop={1}>
        <Typography variant="omega" fontWeight="semiBold">
          {value}
        </Typography>
      </Box>
    </Box>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Box paddingBottom={4}>
      <Typography variant="sigma" textColor="neutral600">
        {label}
      </Typography>
      <Box paddingTop={1}>{children}</Box>
    </Box>
  );
}

export function HomePage(): JSX.Element {
  const api = useMcpApi();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecentCall | null>(null);

  useEffect(() => {
    api
      .overview()
      .then(setData)
      .catch((err: Error) => setError(err.message ?? String(err)));
  }, []);

  return (
    <Box>
      <PageHeader title="Overview" subtitle="Server status, sessions, and recent activity" />

      {error && (
        <Box background="danger100" padding={4} hasRadius marginBottom={6}>
          <Typography textColor="danger700">Failed to load overview: {error}</Typography>
        </Box>
      )}

      {!data && !error && <Typography>Loading…</Typography>}

      {data && (
        <Flex direction="column" gap={6} alignItems="stretch">
          <Card title="Status">
            <Grid.Root gap={6}>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="flex-start">
                <StatRow
                  label="State"
                  value={
                    <Badge backgroundColor={data.enabled ? 'success100' : 'danger100'}>
                      {data.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  }
                />
              </Grid.Item>
              <Grid.Item col={5} s={6} xs={12} direction="column" alignItems="flex-start">
                <StatRow
                  label="Resource URL"
                  value={data.resourceUrl || '(not configured)'}
                />
              </Grid.Item>
              <Grid.Item col={2} s={6} xs={12} direction="column" alignItems="flex-start">
                <StatRow label="OAuth mode" value={data.oauth.mode} />
              </Grid.Item>
              <Grid.Item col={2} s={6} xs={12} direction="column" alignItems="flex-start">
                <StatRow label="DCR" value={data.oauth.dcrEnabled ? 'enabled' : 'disabled'} />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Sessions">
            <Grid.Root gap={6}>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="flex-start">
                <StatRow label="Active total" value={String(data.sessions.total)} />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Recent tool calls">
            <Table colCount={7} rowCount={data.recentCalls.length}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">Time</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Principal</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Client</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Tool</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Status</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Duration</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">&nbsp;</Typography>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.recentCalls.map((c, i) => (
                  <Tr key={i}>
                    <Td>
                      <Typography variant="omega" textColor="neutral700">
                        {new Date(c.ts).toLocaleString()}
                      </Typography>
                    </Td>
                    <Td>
                      <Typography variant="omega">
                        {formatPrincipal(c.principalAdmin, c.principalId)}
                      </Typography>
                    </Td>
                    <Td>
                      <Typography variant="omega" textColor="neutral700">
                        {c.client?.clientName ?? '—'}
                      </Typography>
                    </Td>
                    <Td>
                      <Typography variant="omega" fontWeight="semiBold">
                        {c.tool}
                      </Typography>
                    </Td>
                    <Td>
                      <Badge
                        backgroundColor={c.resultStatus === 'ok' ? 'success100' : 'danger100'}
                      >
                        {c.resultStatus}
                      </Badge>
                    </Td>
                    <Td>
                      <Typography variant="omega" textColor="neutral700">
                        {c.durationMs !== undefined && c.durationMs !== null
                          ? `${c.durationMs}ms`
                          : ''}
                      </Typography>
                    </Td>
                    <Td>
                      <Flex justifyContent="flex-end">
                        <IconButton
                          label="View details"
                          variant="ghost"
                          onClick={() => setSelected(c)}
                        >
                          <Eye />
                        </IconButton>
                      </Flex>
                    </Td>
                  </Tr>
                ))}
                {data.recentCalls.length === 0 && (
                  <Tr>
                    <Td colSpan={7}>
                      <Box paddingTop={6} paddingBottom={6}>
                        <Typography textColor="neutral600">No activity yet.</Typography>
                      </Box>
                    </Td>
                  </Tr>
                )}
              </Tbody>
            </Table>
          </Card>
        </Flex>
      )}

      <Modal.Root
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>Audit entry</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {selected && (
              <Box paddingTop={2}>
                <DetailRow label="Time">
                  <Typography variant="omega">
                    {new Date(selected.ts).toLocaleString()}
                  </Typography>
                </DetailRow>
                <DetailRow label="Tool">
                  <Typography variant="omega" fontWeight="semiBold">
                    {selected.tool}
                  </Typography>
                </DetailRow>
                <DetailRow label="Status">
                  <Badge
                    backgroundColor={
                      selected.resultStatus === 'ok' ? 'success100' : 'danger100'
                    }
                  >
                    {selected.resultStatus}
                  </Badge>
                  {selected.errorCode && (
                    <Box paddingTop={2}>
                      <Typography variant="omega" textColor="danger700">
                        Error: <code>{selected.errorCode}</code>
                      </Typography>
                    </Box>
                  )}
                </DetailRow>
                <DetailRow label="Duration">
                  <Typography variant="omega">
                    {selected.durationMs !== undefined && selected.durationMs !== null
                      ? `${selected.durationMs}ms`
                      : '—'}
                  </Typography>
                </DetailRow>
                <DetailRow label="Principal">
                  <Typography variant="omega">
                    {formatPrincipal(selected.principalAdmin, selected.principalId)}
                    {selected.principalAdmin?.email && (
                      <Typography variant="pi" textColor="neutral600">
                        {' '}
                        ({selected.principalAdmin.email})
                      </Typography>
                    )}
                  </Typography>
                </DetailRow>
                <DetailRow label="Client">
                  <Typography variant="omega">
                    {selected.client?.clientName ?? '—'}
                    {selected.clientId && (
                      <Typography variant="pi" textColor="neutral600">
                        {' '}
                        (<code>{selected.clientId}</code>)
                      </Typography>
                    )}
                  </Typography>
                </DetailRow>
                <DetailRow label="Session">
                  <Typography variant="omega" textColor="neutral700">
                    <code>{selected.sessionId ?? '—'}</code>
                  </Typography>
                </DetailRow>
                <DetailRow label="IP">
                  <Typography variant="omega" textColor="neutral700">
                    {selected.ip ?? '—'}
                  </Typography>
                </DetailRow>
                {selected.userAgent && (
                  <DetailRow label="User-Agent">
                    <Typography variant="omega" textColor="neutral700">
                      {selected.userAgent}
                    </Typography>
                  </DetailRow>
                )}
                <DetailRow label="Parameters">
                  <Box background="neutral100" padding={3} hasRadius>
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 13,
                      }}
                    >
                      {selected.params === undefined || selected.params === null
                        ? '(none)'
                        : JSON.stringify(selected.params, null, 2)}
                    </pre>
                  </Box>
                </DetailRow>
              </Box>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close>
              <Button variant="tertiary">Close</Button>
            </Modal.Close>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </Box>
  );
}
