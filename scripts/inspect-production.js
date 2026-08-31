import { DatabaseSync } from 'node:sqlite';

if (!process.env.DB_FILE) throw new Error('DB_FILE is required');
const database = new DatabaseSync(process.env.DB_FILE, { readOnly: true });

const count = (table) => Number(database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count);
const migrations = database.prepare('SELECT version,applied_at FROM schema_migrations ORDER BY version').all();
const summary = {
  migrations,
  people: count('people'),
  accounts: count('accounts'),
  applications: count('applications'),
  terms: count('organization_terms'),
  appointments: count('appointments'),
  super_admins: Number(database.prepare("SELECT COUNT(*) count FROM system_role_assignments WHERE role='super_admin' AND status='active'").get().count),
  wecom: {
    corp_id_configured: Boolean(process.env.WECOM_CORP_ID),
    agent_id_configured: Boolean(process.env.WECOM_AGENT_ID),
    secret_configured: Boolean(process.env.WECOM_CORP_SECRET),
  },
  internal_http_redirect_hosts_configured: Boolean(process.env.INTERNAL_HTTP_REDIRECT_HOSTS),
};
console.log(JSON.stringify(summary, null, 2));
database.close();
