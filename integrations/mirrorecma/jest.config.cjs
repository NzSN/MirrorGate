/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true,
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  testPathIgnorePatterns: ["<rootDir>/test/smoke\\.test\\.ts$"],
};
