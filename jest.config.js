'use strict';

// Two-project config: unit tests are pure & fast; integration tests boot a
// real fixture Strapi app via globalSetup. Run with:
//   npm test                — unit only (default for local dev + CI lint stage)
//   npm run test:integration — integration only (longer; spawns Strapi)
//   npm run test:all         — both
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
      testPathIgnorePatterns: ['<rootDir>/__tests__/integration/', '<rootDir>/__tests__/fixtures/'],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/integration/**/*.test.ts'],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
      globalSetup: '<rootDir>/__tests__/integration/global-setup.ts',
      globalTeardown: '<rootDir>/__tests__/integration/global-teardown.ts',
      // Integration tests share one Strapi instance; runInBand to avoid
      // multiple workers contending on the same port.
      maxWorkers: 1,
      // Strapi boot can be slow; bump per-test timeout to be safe.
      testTimeout: 60_000,
    },
  ],
  collectCoverageFrom: ['server/src/**/*.ts', '!server/src/**/index.ts'],
};
