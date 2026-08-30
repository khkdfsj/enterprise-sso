import { interactionPolicy, Provider } from 'oidc-provider';
import { config } from '../config.js';
import { SqliteOidcAdapter } from './sqlite-adapter.js';
import { loadJwks } from './jwks.js';
import { findAccountClaims } from '../repositories/accounts.js';

export async function createProvider() {
  const jwks = await loadJwks();
  const policy = interactionPolicy.base();
  policy.add(new interactionPolicy.Prompt(
    { name: 'access', requestable: false },
    new interactionPolicy.Check(
      'application_access',
      'Application access must be checked',
      (ctx) => Boolean(ctx.oidc.session?.accountId && !ctx.oidc.result?.access),
    ),
  ), 1);
  const provider = new Provider(config.issuer, {
    adapter: SqliteOidcAdapter,
    clients: [],
    jwks,
    cookies: {
      keys: config.cookieKeys,
      short: { secure: config.production, sameSite: 'lax', httpOnly: true },
      long: { secure: config.production, sameSite: 'lax', httpOnly: true },
    },
    claims: {
      openid: ['sub'],
      profile: ['name', 'preferred_username'],
      enterprise: ['employee_no', 'department', 'position', 'authorization_version'],
    },
    scopes: ['openid', 'profile', 'enterprise'],
    responseTypes: ['code'],
    pkce: { required: () => true },
    rotateRefreshToken: true,
    ttl: {
      AccessToken: 600,
      AuthorizationCode: config.ttl.authorizationCode,
      IdToken: 300,
      Interaction: 600,
      Session: config.ttl.session,
      Grant: config.ttl.session,
      RefreshToken: config.ttl.session,
    },
    features: {
      devInteractions: { enabled: false },
      introspection: { enabled: true },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: true },
    },
    interactions: {
      policy,
      url(_ctx, interaction) {
        return `/interaction/${interaction.uid}`;
      },
    },
    async findAccount(_ctx, personId) {
      const account = await findAccountClaims(personId);
      if (!account) return undefined;
      return {
        accountId: account.id,
        async claims() {
          return {
            sub: account.id,
            name: account.display_name,
            preferred_username: account.username,
            employee_no: account.employee_no,
            department: account.department_name ? { id: account.department_id, name: account.department_name } : null,
            position: account.position_name ? { id: account.position_id, name: account.position_name } : null,
            authorization_version: Number(account.authorization_version),
          };
        },
      };
    },
  });
  provider.proxy = true;
  return provider;
}
