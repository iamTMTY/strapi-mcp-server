export default ({ env }: { env: { (key: string, fallback?: unknown): string; int(key: string, fallback?: number): number; array(key: string, fallback?: unknown[]): string[] } }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS', ['test-app-key-1', 'test-app-key-2']),
  },
});
