import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundledCa = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../certs/ap-south-1-bundle.pem",
);

const caCandidates = () =>
  [
    process.env.DATABASE_SSL_CA,
    "/app/certs/rds-ca.pem",
    bundledCa,
  ].filter((p): p is string => Boolean(p));

/** Amazon RDS uses a private CA. Node's default store rejects it as self-signed. */
export function postgresSsl(needsSsl: boolean):
  | { rejectUnauthorized: boolean; ca?: string }
  | undefined {
  if (!needsSsl) return undefined;
  const caPath = caCandidates().find((p) => fs.existsSync(p));
  return {
    rejectUnauthorized: true,
    ...(caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {}),
  };
}
