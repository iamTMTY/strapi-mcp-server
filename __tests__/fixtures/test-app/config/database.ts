import { join } from 'path';

export default ({ env }: { env: (key: string, fallback?: string) => string }) => ({
  connection: {
    client: 'sqlite',
    connection: {
      // Keep the SQLite file outside dist/ — `strapi develop` cleans dist/ on
      // every reload, which would otherwise delete the DB out from under an
      // open handle and surface as "attempt to write a readonly database".
      // .data/ is gitignored.
      filename: env('DATABASE_FILENAME', join(__dirname, '..', '..', '.data', 'database.sqlite')),
    },
    useNullAsDefault: true,
  },
});
