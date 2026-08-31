process.env.CI_PUBLIC_PREFIX = '/enterprise-sso';
await import('./ci-e2e.js');
