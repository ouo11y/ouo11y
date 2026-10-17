// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const base = require('./.config/jest.config');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...base,
  // The haste crawl hangs for minutes when watchman is installed on the host; the plugin tree is small.
  watchman: false,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // The npm workspace hoists React 18 (examples/web) to the root; @testing-library/react is hoisted
    // too and would otherwise load that copy while @grafana/ui and src use the plugin's React 19.
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom/$1',
  },
};
