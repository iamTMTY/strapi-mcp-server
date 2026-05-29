import { useEffect, useState } from 'react';
import { Box, Typography, Table, Thead, Tbody, Tr, Td, Th } from '@strapi/design-system';
import { useMcpApi } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

interface ToolRow {
  name: string;
  scope: string;
}

export function Tools(): JSX.Element {
  const api = useMcpApi();
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .tools()
      .then((d: { tools: ToolRow[] }) => setTools(d.tools ?? []))
      .catch((err: Error) => setError(err.message ?? String(err)));
  }, []);

  return (
    <Box>
      <PageHeader
        title="Tools"
        subtitle="MCP tools registered for this server, with the OAuth scope each requires"
      />

      {error && (
        <Box background="danger100" padding={4} hasRadius marginBottom={6}>
          <Typography textColor="danger700">Failed to load tools: {error}</Typography>
        </Box>
      )}

      <Box background="neutral0" hasRadius shadow="tableShadow">
        <Table colCount={2} rowCount={tools.length}>
          <Thead>
            <Tr>
              <Th>
                <Typography variant="sigma">Tool</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">Required scope</Typography>
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {tools.map((t) => (
              <Tr key={t.name}>
                <Td>
                  <Typography variant="omega" fontWeight="semiBold">
                    {t.name}
                  </Typography>
                </Td>
                <Td>
                  <Typography variant="omega" textColor="neutral700">
                    {t.scope}
                  </Typography>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </Box>
  );
}
