import type { ReactNode } from 'react';
import { Box, Flex, Typography } from '@strapi/design-system';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/**
 * Matches the Strapi "Settings → Overview" pattern: large alpha title with
 * the subtitle on its own line directly underneath. Optional right-aligned
 * actions slot for buttons.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps): JSX.Element {
  return (
    <Flex justifyContent="space-between" alignItems="flex-start" paddingBottom={6}>
      <Box>
        <Typography variant="alpha" tag="h1">
          {title}
        </Typography>
        {subtitle && (
          <Box paddingTop={1}>
            <Typography variant="epsilon" textColor="neutral600">
              {subtitle}
            </Typography>
          </Box>
        )}
      </Box>
      {actions && <Box>{actions}</Box>}
    </Flex>
  );
}
