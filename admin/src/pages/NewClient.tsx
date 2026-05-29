import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

interface CreatedResponse {
  client: { clientId: string; clientName: string };
  clientSecret?: string;
}

export function NewClient(): JSX.Element {
  const api = useMcpApi();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [redirects, setRedirects] = useState('');
  const [isConfidential, setIsConfidential] = useState(false);
  const [scopes, setScopes] = useState<string[]>(ALL_SCOPES.map((s) => s.id));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedResponse | null>(null);

  async function submit(): Promise<void> {
    if (!name.trim() || scopes.length === 0) {
      setError('Name and at least one scope are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Empty redirect URIs → default to the CLI-friendly loopback URL.
      // Port is ignored at match time, so a CLI on any free port matches.
      const parsedRedirects = redirects
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const body = {
        clientName: name.trim(),
        redirectUris: parsedRedirects.length > 0 ? parsedRedirects : ['http://localhost/callback'],
        scopes,
        isConfidential,
      };
      const result = await api.createClient(body);
      setCreated(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <Box>
        <PageHeader
          title="Client created"
          subtitle="Save the secret now — it cannot be retrieved later."
          actions={
            <Button variant="tertiary" onClick={() => navigate('/plugins/mcp-server/clients')}>
              Back to clients
            </Button>
          }
        />
        <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
          <Flex direction="column" gap={4} alignItems="stretch">
            <Box>
              <Typography variant="sigma" textColor="neutral600">
                Client name
              </Typography>
              <Box paddingTop={1}>
                <Typography variant="omega" fontWeight="semiBold">
                  {created.client.clientName}
                </Typography>
              </Box>
            </Box>
            <Box>
              <Typography variant="sigma" textColor="neutral600">
                client_id
              </Typography>
              <Box paddingTop={1}>
                <Typography variant="omega">{created.client.clientId}</Typography>
              </Box>
            </Box>
            {created.clientSecret && (
              <Box background="warning100" padding={4} hasRadius>
                <Typography variant="sigma" textColor="warning700">
                  client_secret (shown once)
                </Typography>
                <Box paddingTop={1}>
                  <Typography variant="omega" fontWeight="semiBold" textColor="warning700">
                    {created.clientSecret}
                  </Typography>
                </Box>
              </Box>
            )}
          </Flex>
        </Box>
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="New OAuth client"
        subtitle="Register an MCP client that will obtain access tokens via OAuth 2.1 + PKCE"
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
                    placeholder="e.g. Claude Desktop"
                  />
                </Box>
              </Box>
            </Grid.Item>
            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Box>
                <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                  Client type
                </Typography>
                <Box paddingTop={3}>
                  <Checkbox
                    checked={isConfidential}
                    onCheckedChange={(c: boolean | 'indeterminate') =>
                      setIsConfidential(c === true)
                    }
                  >
                    Confidential client (generates a client_secret)
                  </Checkbox>
                </Box>
              </Box>
            </Grid.Item>
          </Grid.Root>

          <Box>
            <Typography variant="pi" fontWeight="bold" textColor="neutral800">
              Redirect URIs (optional)
            </Typography>
            <Box paddingTop={1} paddingBottom={1}>
              <Typography variant="pi" textColor="neutral600">
                Leave blank for CLI clients (Claude Code, Cursor, Codex, etc.) — defaults to <code>http://localhost/callback</code>, any loopback port matches. One per line, exact match for non-loopback URIs.
              </Typography>
            </Box>
            <Textarea
              name="redirectUris"
              value={redirects}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setRedirects(e.target.value)
              }
              placeholder="http://localhost/callback"
              rows={3}
            />
          </Box>

          <Box>
            <Typography variant="pi" fontWeight="bold" textColor="neutral800">
              Scopes
            </Typography>
            <Box paddingTop={1} paddingBottom={2}>
              <Typography variant="pi" textColor="neutral600">
                Permissions the client will request at authorization time.
              </Typography>
            </Box>
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

          <Flex justifyContent="flex-end" gap={2}>
            <Button
              variant="tertiary"
              onClick={() => navigate('/plugins/mcp-server/clients')}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button loading={submitting} onClick={submit}>
              Create client
            </Button>
          </Flex>
        </Flex>
      </Box>
    </Box>
  );
}
