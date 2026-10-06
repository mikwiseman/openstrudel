// Additive schema: existing owners, payments and provider operations are retained.
export const OPENSTRUDEL_SCHEMA=`
CREATE TABLE IF NOT EXISTS os_authorizations(
 id TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, client_id TEXT NOT NULL,
 redirect_uri TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL,
 created INTEGER NOT NULL, expires INTEGER NOT NULL, force_login INTEGER NOT NULL,
 user_id TEXT REFERENCES users(id), auth_time INTEGER, code_hash TEXT UNIQUE,
 consumed INTEGER NOT NULL DEFAULT 0, grant_id TEXT);
CREATE TABLE IF NOT EXISTS os_grants(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,
 auth_time INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS os_access(
 digest TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES os_grants(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS os_refresh(
 digest TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES os_grants(id),expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS os_grants_owner ON os_grants(user_id);
CREATE TABLE IF NOT EXISTS os_quotes(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,
 body TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS os_orders(
 order_id TEXT PRIMARY KEY REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES users(id),
 client_id TEXT NOT NULL,quote_id TEXT NOT NULL REFERENCES os_quotes(id),fingerprint TEXT NOT NULL,
 installation_id TEXT NOT NULL,return_uri TEXT NOT NULL,return_state TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS os_installations(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),order_id TEXT UNIQUE NOT NULL REFERENCES orders(id),
 profile TEXT NOT NULL,release_sha256 TEXT NOT NULL,public_key_sha256 TEXT NOT NULL,owner_token_hash TEXT NOT NULL,
 bootstrap_sealed TEXT,state TEXT NOT NULL DEFAULT 'pending',certificate_sha256 TEXT,
 checked_at INTEGER,details TEXT,error TEXT,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS os_claims(
 digest TEXT PRIMARY KEY,installation_id TEXT NOT NULL REFERENCES os_installations(id),user_id TEXT NOT NULL REFERENCES users(id),
 grant_id TEXT NOT NULL REFERENCES os_grants(id),expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,recover_owner INTEGER NOT NULL DEFAULT 0);
`;
