import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Button,
  Flex,
  Typography,
  TextInput,
  Textarea,
  Checkbox,
  Grid,
} from '@strapi/design-system';
import { ArrowLeft } from '@strapi/icons';
import { useMcpApi } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

const ALL_SCOPES = [
  { id: 'strapi:content:read', label: 'Read content (list types, schemas, entries)' },
  { id: 'strapi:content:write', label: 'Create / update content entries (draft only)' },
  { id: 'strapi:media:read', label: 'List media files' },
  { id: 'strapi:media:write', label: 'Upload media files' },
];

interface Client {
  clientId: string;
  clientName: string;
  isConfidential: boolean;
  redirectUris: string[];
  scopes: string[];
  disabled: boolean;
}

export function EditClient(): JSX.Element {
  const api = useMcpApi();
  const navigate = useNavigate();
  const { clientId } = useParams<{ clientId: string }>();

  const [original, setOriginal] = useState<Client | null>(null);
  const [name, setName] = useState('');
  const [redirects, setRedirects] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientId) return;
    api
      .getClient(clientId)
      .then((c: Client) => {
        setOriginal(c);
        setName(c.clientName);
        setRedirects((c.redirectUris ?? []).join('\n'));
        setScopes(c.scopes ?? []);
        setDisabled(c.disabled);
      })
      .catch((err: Error) => setError(err.message ?? String(err)))
      .finally(() => setLoading(false));
  }, [clientId]);

  async function submit(): Promise<void> {
    if (!clientId) return;
    if (!name.trim() || !redirects.trim() || scopes.length === 0) {
      setError('Name, at least one redirect URI, and at least one scope are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.updateClient(clientId, {
        clientName: name.trim(),
        redirectUris: redirects
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        scopes,
        disabled,
      });
      navigate('/plugins/mcp-server/clients');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !original) {
    return (
      <Box>
        <PageHeader title="Edit client" />
        <Typography>Loading…</Typography>
      </Box>
    );
  }

  if (!original) {
    return (
      <Box>
        <PageHeader title="Edit client" />
        <Box background="danger100" padding={4} hasRadius>
          <Typography textColor="danger700">
            {error ?? 'Client not found'}
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="Edit client"
        subtitle={`Update settings for ${original.clientName}`}
        actions={
          <Button
            variant="tertiary"
            startIcon={<ArrowLeft />}
            onClick={() => navigate('/plugins/mcp-server/clients')}
          >
            Back
          </Button>
        }
      />

      {error && (
        <Box background="danger100" padding={4} hasRadius marginBottom={6}>
          <Typography textColor="danger700">{error}</Typography>
        </Box>
      )}

      <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
        <Flex direction="column" gap={6} alignItems="stretch">
          <Grid.Root gap={6}>
            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Box>
                <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                  Client name
                </Typography>
                <Box paddingTop={1}>
                  <TextInput
                    name="clientName"
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setName(e.target.value)
                    }
                  />
                </Box>
              </Box>
            </Grid.Item>
            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Box>
                <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                  Client ID
                </Typography>
                <Box paddingTop={1}>
                  <TextInput name="clientId" value={original.clientId} disabled aria-readonly />
                </Box>
              </Box>
            </Grid.Item>
            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Box paddingTop={3}>
                <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                  Type
                </Typography>
                <Box paddingTop={2}>
                  <Typography variant="omega" textColor="neutral700">
                    {original.isConfidential
                      ? 'Confidential (cannot be changed after creation)'
                      : 'Public (cannot be changed after creation)'}
                  </Typography>
                </Box>
              </Box>
            </Grid.Item>
            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Box paddingTop={6}>
                <Checkbox
                  checked={disabled}
                  onCheckedChange={(c: boolean | 'indeterminate') => setDisabled(c === true)}
                >
                  Disabled — token issuance is blocked for this client
                </Checkbox>
              </Box>
            </Grid.Item>
          </Grid.Root>

          <Box>
            <Typography variant="pi" fontWeight="bold" textColor="neutral800">
              Redirect URIs
            </Typography>
            <Box paddingTop={2}>
              <Textarea
                name="redirectUris"
                value={redirects}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setRedirects(e.target.value)
                }
                rows={5}
              />
            </Box>
            <Box paddingTop={1}>
              <Typography variant="pi" textColor="neutral600">
                One per line — exact match, no wildcards.
              </Typography>
            </Box>
          </Box>

          <Box>
            <Typography variant="pi" fontWeight="bold" textColor="neutral800">
              Scopes
            </Typography>
            <Box paddingTop={2}>
              <Flex direction="column" gap={2} alignItems="stretch">
                {ALL_SCOPES.map((s) => (
                  <Checkbox
                    key={s.id}
                    checked={scopes.includes(s.id)}
                    onCheckedChange={(c: boolean | 'indeterminate') => {
                      if (c === true) setScopes((prev) => [...prev, s.id]);
                      else setScopes((prev) => prev.filter((x) => x !== s.id));
                    }}
                  >
                    <Typography variant="omega">
                      <code>{s.id}</code> — {s.label}
                    </Typography>
                  </Checkbox>
                ))}
              </Flex>
            </Box>
          </Box>

          <Flex justifyContent="flex-end" gap={2}>
            <Button
              variant="tertiary"
              onClick={() => navigate('/plugins/mcp-server/clients')}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button loading={submitting} onClick={submit}>
              Save changes
            </Button>
          </Flex>
        </Flex>
      </Box>
    </Box>
  );
}
