import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Modal,
  Typography,
  Table,
  Thead,
  Tbody,
  Tr,
  Td,
  Th,
} from '@strapi/design-system';
import { Pencil, Plus, Trash } from '@strapi/icons';
import { Filters, Pagination, SearchInput, useQueryParams } from '@strapi/strapi/admin';
import styled from 'styled-components';
import { useMcpApi } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { applyMcpQuery, hasActiveQuery, paginate, type McpListQuery } from '../lib/applyQuery';

const CLIENT_FILTERS = [
  {
    name: 'type',
    label: 'Type',
    type: 'enumeration' as const,
    options: [
      { label: 'Confidential', value: 'confidential' },
      { label: 'Public', value: 'public' },
    ],
  },
  {
    name: 'createdAt',
    label: 'Created',
    type: 'date' as const,
  },
];

interface AdminUser {
  id: number;
  email?: string;
  firstname?: string;
  lastname?: string;
  username?: string;
}

interface ClientRow {
  clientId: string;
  clientName: string;
  isConfidential: boolean;
  redirectUris: string[];
  scopes: string[];
  disabled: boolean;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  ownerAdmin?: AdminUser | null;
  createdByAdmin?: AdminUser | null;
}

function formatAdmin(user: AdminUser | null | undefined): string {
  if (!user) return '—';
  const name = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return name || user.email || user.username || `#${user.id}`;
}

const ClickableTr = styled(Tr)`
  cursor: pointer;
  transition: background-color 100ms ease;
  &:hover td {
    background: ${({ theme }) => theme.colors.neutral100};
  }
`;

function formatLastUsed(value: string | null | undefined): string {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleString();
}

function formatCreated(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
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

export function Clients(): JSX.Element {
  const api = useMcpApi();
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ClientRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClientRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [{ query }] = useQueryParams<McpListQuery>();

  const filtered = useMemo(
    () =>
      applyMcpQuery(clients, query, {
        searchText: (c) =>
          [
            c.clientName,
            c.clientId,
            formatAdmin(c.ownerAdmin),
            formatAdmin(c.createdByAdmin),
          ].join(' '),
        field: (c, name) => {
          if (name === 'type') return c.isConfidential ? 'confidential' : 'public';
          if (name === 'createdAt') return c.createdAt ?? '';
          return '';
        },
      }),
    [clients, query]
  );
  const paged = useMemo(() => paginate(filtered, query), [filtered, query]);

  const hasFilters = hasActiveQuery(query);

  function refresh(): Promise<void> {
    return api
      .listClients()
      .then((d: { clients: ClientRow[] }) => setClients(d.clients ?? []))
      .catch((err: Error) => setError(err.message ?? String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteClient(pendingDelete.clientId);
      setPendingDelete(null);
      setSelected(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Box>
      <PageHeader
        title="Clients"
        subtitle="OAuth 2.1 clients allowed to obtain MCP access tokens"
        actions={
          <Button startIcon={<Plus />} onClick={() => navigate('new')}>
            New client
          </Button>
        }
      />

      {error && (
        <Box background="danger100" padding={4} hasRadius marginBottom={6}>
          <Typography textColor="danger700">Failed: {error}</Typography>
        </Box>
      )}

      <Flex gap={1} paddingBottom={4} alignItems="flex-start">
        <SearchInput
          label="Search clients"
          placeholder="Search by name, client ID, owner, or creator"
        />
        <Filters.Root options={CLIENT_FILTERS}>
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
                <Typography variant="sigma">Name</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">Type</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">Created by</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">Owner</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">Created</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">&nbsp;</Typography>
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {paged.rows.map((c) => (
              <ClickableTr
                key={c.clientId}
                onClick={() => setSelected(c)}
                role="button"
                tabIndex={0}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(c);
                  }
                }}
              >
                <Td>
                  <Typography variant="omega" fontWeight="semiBold">
                    {c.clientName}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega">
                    {c.isConfidential ? 'Confidential' : 'Public'}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {formatAdmin(c.createdByAdmin)}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {formatAdmin(c.ownerAdmin)}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {formatCreated(c.createdAt)}
                  </Typography>
                </Td>
                <Td onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                  <Flex gap={2} justifyContent="flex-end">
                    <IconButton
                      label="Edit"
                      variant="ghost"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        navigate(`${c.clientId}/edit`);
                      }}
                    >
                      <Pencil />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      variant="ghost"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        setPendingDelete(c);
                      }}
                    >
                      <Trash />
                    </IconButton>
                  </Flex>
                </Td>
              </ClickableTr>
            ))}
            {!loading && paged.rows.length === 0 && (
              <Tr>
                <Td colSpan={6}>
                  <Box paddingTop={6} paddingBottom={6}>
                    <Typography textColor="neutral600">
                      {clients.length === 0
                        ? 'No OAuth clients yet. Create one, or wait for an MCP client to register via DCR.'
                        : hasFilters
                          ? 'No clients match the current search or filters.'
                          : 'No clients to display.'}
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

      {/* Detail modal */}
      <Modal.Root
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>{selected?.clientName ?? 'Client'}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {selected && (
              <Box paddingTop={2}>
                <DetailRow label="Client ID">
                  <Typography variant="omega" textColor="neutral800">
                    <code>{selected.clientId}</code>
                  </Typography>
                </DetailRow>
                <DetailRow label="Type">
                  <Typography variant="omega">
                    {selected.isConfidential ? 'Confidential' : 'Public'}
                  </Typography>
                </DetailRow>
                <DetailRow label="Created by">
                  <Typography variant="omega" textColor="neutral800">
                    {formatAdmin(selected.createdByAdmin)}
                    {selected.createdByAdmin?.email && (
                      <Typography variant="pi" textColor="neutral600">
                        {' '}
                        ({selected.createdByAdmin.email})
                      </Typography>
                    )}
                  </Typography>
                </DetailRow>
                <DetailRow label="Owner">
                  <Typography variant="omega" textColor="neutral800">
                    {formatAdmin(selected.ownerAdmin)}
                    {selected.ownerAdmin?.email && (
                      <Typography variant="pi" textColor="neutral600">
                        {' '}
                        ({selected.ownerAdmin.email})
                      </Typography>
                    )}
                  </Typography>
                </DetailRow>
                <DetailRow label="Created">
                  <Typography variant="omega" textColor="neutral800">
                    {formatCreated(selected.createdAt)}
                  </Typography>
                </DetailRow>
                <DetailRow label="Last used">
                  <Typography variant="omega" textColor="neutral800">
                    {formatLastUsed(selected.lastUsedAt)}
                  </Typography>
                </DetailRow>
                <DetailRow label="Scopes">
                  {selected.scopes.length === 0 ? (
                    <Typography variant="omega" textColor="neutral600">
                      (none)
                    </Typography>
                  ) : (
                    <Flex direction="column" gap={1} alignItems="flex-start">
                      {selected.scopes.map((s) => (
                        <Typography key={s} variant="omega">
                          <code>{s}</code>
                        </Typography>
                      ))}
                    </Flex>
                  )}
                </DetailRow>
                <DetailRow label="Redirect URIs">
                  {selected.redirectUris.length === 0 ? (
                    <Typography variant="omega" textColor="neutral600">
                      (none)
                    </Typography>
                  ) : (
                    <Flex direction="column" gap={1} alignItems="flex-start">
                      {selected.redirectUris.map((u) => (
                        <Typography key={u} variant="omega" textColor="neutral800">
                          <code>{u}</code>
                        </Typography>
                      ))}
                    </Flex>
                  )}
                </DetailRow>
              </Box>
            )}
          </Modal.Body>
          <Modal.Footer justifyContent="space-between">
            <Modal.Close>
              <Button variant="tertiary">Cancel</Button>
            </Modal.Close>
            <Flex gap={2}>
              <Button
                variant="danger-light"
                startIcon={<Trash />}
                onClick={() => {
                  if (selected) {
                    setPendingDelete(selected);
                    setSelected(null);
                  }
                }}
              >
                Delete
              </Button>
              <Button
                variant="default"
                startIcon={<Pencil />}
                onClick={() => {
                  if (selected) {
                    const id = selected.clientId;
                    setSelected(null);
                    navigate(`${id}/edit`);
                  }
                }}
              >
                Edit
              </Button>
            </Flex>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>

      {/* Delete confirmation */}
      <Dialog.Root
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <Dialog.Content>
          <Dialog.Header>Delete client</Dialog.Header>
          <Dialog.Body>
            <Typography>
              Delete <strong>{pendingDelete?.clientName}</strong>? This revokes the client_id,
              invalidates any active sessions tied to it, and removes its stored refresh
              tokens. This cannot be undone.
            </Typography>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Cancel>
              <Button variant="tertiary">Cancel</Button>
            </Dialog.Cancel>
            <Dialog.Action>
              <Button variant="danger-light" loading={deleting} onClick={confirmDelete}>
                Delete client
              </Button>
            </Dialog.Action>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </Box>
  );
}
