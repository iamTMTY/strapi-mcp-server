import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Flex,
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
import { Filters, Pagination, SearchInput, useQueryParams } from '@strapi/strapi/admin';
import { useMcpApi } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { applyMcpQuery, hasActiveQuery, paginate, type McpListQuery } from '../lib/applyQuery';

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

interface Entry {
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

function formatPrincipal(admin: PrincipalAdmin | null | undefined, fallbackId: string): string {
  if (!admin) return fallbackId ? `#${fallbackId}` : '—';
  const name = [admin.firstname, admin.lastname].filter(Boolean).join(' ').trim();
  return name || admin.email || admin.username || `#${admin.id}`;
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

export function AuditLog(): JSX.Element {
  const api = useMcpApi();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [{ query }] = useQueryParams<McpListQuery>();

  useEffect(() => {
    api
      .listAudit({ limit: 200 })
      .then((d: { entries: Entry[] }) => setEntries(d.entries ?? []))
      .catch((err: Error) => setError(err.message ?? String(err)))
      .finally(() => setLoading(false));
  }, []);

  // Distinct tools present in the loaded entries, for the Tool filter dropdown.
  const auditFilters = useMemo(
    () => [
      {
        name: 'tool',
        label: 'Tool',
        type: 'enumeration' as const,
        options: Array.from(new Set(entries.map((e) => e.tool).filter(Boolean)))
          .sort()
          .map((t) => ({ label: t, value: t })),
      },
      {
        name: 'resultStatus',
        label: 'Status',
        type: 'enumeration' as const,
        options: [
          { label: 'ok', value: 'ok' },
          { label: 'error', value: 'error' },
        ],
      },
      {
        name: 'ts',
        label: 'Date',
        type: 'date' as const,
      },
    ],
    [entries]
  );

  const filtered = useMemo(
    () =>
      applyMcpQuery(entries, query, {
        searchText: (e) =>
          [
            e.tool,
            formatPrincipal(e.principalAdmin, e.principalId),
            e.client?.clientName ?? '',
            e.errorCode ?? '',
          ].join(' '),
        field: (e, name) => {
          if (name === 'tool') return e.tool;
          if (name === 'resultStatus') return e.resultStatus;
          if (name === 'ts') return e.ts;
          return '';
        },
      }),
    [entries, query]
  );
  const paged = useMemo(() => paginate(filtered, query), [filtered, query]);

  const hasFilters = hasActiveQuery(query);

  return (
    <Box>
      <PageHeader
        title="Audit Log"
        subtitle="Every MCP tool call, recorded with redacted parameters"
      />

      {error && (
        <Box background="danger100" padding={4} hasRadius marginBottom={6}>
          <Typography textColor="danger700">Failed to load audit log: {error}</Typography>
        </Box>
      )}

      <Flex gap={1} paddingBottom={4} alignItems="flex-start">
        <SearchInput
          label="Search audit log"
          placeholder="Search by tool, principal, client, or error"
        />
        <Filters.Root options={auditFilters}>
          <Filters.Trigger />
          <Filters.Popover />
          <Filters.List />
        </Filters.Root>
      </Flex>

      <Box background="neutral0" hasRadius shadow="tableShadow">
        <Table colCount={6} rowCount={paged.rows.length}>
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
            {paged.rows.map((e, i) => (
              <Tr key={i}>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {new Date(e.ts).toLocaleString()}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega">
                    {formatPrincipal(e.principalAdmin, e.principalId)}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {e.client?.clientName ?? '—'}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega" fontWeight="semiBold">
                    {e.tool}
                  </Typography>
                </Td>
                <Td>
                  <Badge
                    backgroundColor={e.resultStatus === 'ok' ? 'success100' : 'danger100'}
                  >
                    {e.resultStatus}
                  </Badge>
                </Td>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {e.durationMs !== undefined && e.durationMs !== null
                      ? `${e.durationMs}ms`
                      : ''}
                  </Typography>
                </Td>
                <Td>
                  <Flex justifyContent="flex-end">
                    <IconButton
                      label="View details"
                      variant="ghost"
                      onClick={() => setSelected(e)}
                    >
                      <Eye />
                    </IconButton>
                  </Flex>
                </Td>
              </Tr>
            ))}
            {!loading && paged.rows.length === 0 && (
              <Tr>
                <Td colSpan={7}>
                  <Box paddingTop={6} paddingBottom={6}>
                    <Typography textColor="neutral600">
                      {entries.length === 0
                        ? 'No tool calls recorded yet.'
                        : hasFilters
                          ? 'No entries match the current search or filters.'
                          : 'No entries to display.'}
                    </Typography>
                  </Box>
                </Td>
              </Tr>
            )}
          </Tbody>
        </Table>
      </Box>

      {paged.total > 0 && (
        <Box paddingTop={4}>
          <Pagination.Root pageCount={paged.pageCount} total={paged.total}>
            <Pagination.PageSize />
            <Pagination.Links />
          </Pagination.Root>
        </Box>
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
