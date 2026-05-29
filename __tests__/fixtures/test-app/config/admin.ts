export default ({ env }: { env: (key: string, fallback?: string) => string }) => ({
  auth: {
    secret: env('ADMIN_JWT_SECRET', 'test-admin-jwt-secret-only-for-fixture'),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT', 'test-api-token-salt-only-for-fixture'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT', 'test-transfer-token-salt-only-for-fixture'),
    },
  },
  flags: {
    nps: false,
    promoteEE: false,
  },
});
