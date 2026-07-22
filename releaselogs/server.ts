/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import net from "net";
import https from "https";
import tls from "tls";
import path from "path";
import fs from "fs";
import os from "os";
import * as yaml from "js-yaml";
import { Agent as UndiciAgent, type Dispatcher } from "undici";
import { pipeline } from "stream/promises";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "crypto";
import { Client } from "ldapts";
import { exec } from "child_process";
import { createServer as createViteServer } from "vite";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import JSZip from "jszip";
import {
  S3_MOCK_ARCHIVES,
  generateS3ArchiveCatalogLogs,
  buildCatalogLogFromS3File,
  s3KeyToDocId,
  type S3ListedFile,
} from "./src/data/s3ArchiveCatalog";
import { parseSearchQuery } from "./src/utils/searchQuery";

// Ensure a safe simulation directory exists for sandbox testing
const SANDBOX_STORAGE_DIR = path.join(process.cwd(), "data-sim-s3");
if (!fs.existsSync(SANDBOX_STORAGE_DIR)) {
  fs.mkdirSync(SANDBOX_STORAGE_DIR, { recursive: true });
}

// Initial mock files to reside in simulated mode (includes catalog zip archives)
const MOCK_FILES_DB = [
  ...S3_MOCK_ARCHIVES.map((a) => ({
    key: a.key,
    size: a.size,
    lastModified: a.lastModified,
    contentType: a.contentType,
  })),
  { key: "audits/pci-dss-compliance-report_q1.pdf", size: 452100, lastModified: "2026-04-12T12:00:00.000Z", contentType: "application/pdf" },
  { key: "incidents/secops-alert-logs.json", size: 85400, lastModified: "2026-05-25T02:15:30.000Z", contentType: "application/json" },
];

// Write initial mock files to simulated disk physically so proxy download works out of the box in the sandbox!
MOCK_FILES_DB.forEach(f => {
  const filePath = path.join(SANDBOX_STORAGE_DIR, f.key.replace(/\//g, "_"));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `[SIMULATED ARCHIVE DATA ${f.key}]\n- Size: ${f.size}\n- Timestamp: ${f.lastModified}\n- Content: Decrypted private telemetry package.`);
  }
});

import { generateMockLogs } from "./src/data/mockElasticData";

const DATA_DIR = process.env.APP_DATA_DIR || path.join(process.cwd(), "data");
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(DATA_DIR, "config.yaml");
const CONFIG_TEMPLATE_PATH = path.join(process.cwd(), "config.yaml");
const LOCAL_USERS_PATH = path.join(DATA_DIR, "local-users.json");
const DOWNLOAD_TEMP_DIR = process.env.DOWNLOAD_TEMP_DIR || path.join(os.tmpdir(), "releaselogs-downloads");
const SECRET_MASK = "••••••••••••••••";
const APP_BOOT_ID = randomBytes(16).toString("hex");
const APP_SESSION_COOKIE = "releaselogs_session";
const appSessions = new Map<string, { username: string; expiresAt: number }>();

function createFallbackConfig() {
  return {
    elasticsearch: {
      nodeUrls: "",
      authMethod: "anonymous",
      username: "",
      password: "",
      token: "",
      enableSSL: false,
      verifyServerCertificate: false,
      caCertificateName: "",
      caCertificateContent: "",
      clientCertificateName: "",
      clientCertificateContent: "",
      clientKeyName: "",
      clientKeyContent: "",
      clusterName: "",
      shardsCount: 0,
      replicasCount: 0,
    },
    s3: {
      endpointUrl: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucketName: "",
      region: "",
      enableSSL: false,
      verifyCertificates: false,
      caCertificateName: "",
      caCertificateContent: "",
      forcePathStyle: false,
      catalogIndex: "",
      proxyAuthEnabled: false,
      proxyAuthMethod: "basic",
      proxyBasicUsername: "",
      proxyApiKeys: [],
    },
    ldap: {
      ldapUrl: "",
      userDnPattern: "",
      emailAttribute: "mail",
      searchFilter: "",
      searchBase: "",
      managerDn: "",
      managerPassword: "",
      serverUrl: "",
      bindDn: "",
      bindPassword: "",
      baseDn: "",
      userSearchFilter: "",
      groupSearchFilter: "",
      enableSSL: false,
      verifyCertificates: false,
      caCertificateName: "",
      caCertificateContent: "",
      activeDirectoryMode: false,
    },
    audit: {
      elasticsearchIndex: "",
    },
    discover: {
      defaultIndex: "",
      linkRules: [],
    },
    app: {
      enableHTTPS: false,
      httpsPort: 0,
      certificateName: "",
      certificateContent: "",
      privateKeyName: "",
      privateKeyContent: "",
      commonName: "",
      validDays: 0,
      sessionTimeoutMinutes: 60,
      localUserEmailDomain: "",
    },
  };
}

type AppConfig = ReturnType<typeof createFallbackConfig>;

function loadDefaultConfigTemplate(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_TEMPLATE_PATH)) {
      const raw = fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf8");
      const loaded = (yaml.load(raw) as Partial<AppConfig>) || {};
      return mergeConfig(loaded, createFallbackConfig());
    }
  } catch (err: any) {
    console.warn(`[CONFIG] Failed to load config template from ${CONFIG_TEMPLATE_PATH}: ${err.message}`);
  }
  return createFallbackConfig();
}

const DEFAULT_CONFIG: AppConfig = loadDefaultConfigTemplate();

function mergeConfig(config: Partial<AppConfig> = {}, baseConfig: AppConfig = createFallbackConfig()): AppConfig {
  return {
    elasticsearch: { ...baseConfig.elasticsearch, ...(config.elasticsearch || {}) },
    s3: normalizeS3Config({ ...baseConfig.s3, ...(config.s3 || {}) }),
    ldap: normalizeLdapConfig({ ...baseConfig.ldap, ...(config.ldap || {}) }),
    audit: { ...baseConfig.audit, ...(config.audit || {}) },
    discover: { ...baseConfig.discover, ...(config.discover || {}) },
    app: normalizeAppConfig({ ...baseConfig.app, ...(config.app || {}) }),
  };
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

function normalizeNumber(value: unknown, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeLdapConfig(config: AppConfig["ldap"]): AppConfig["ldap"] {
  const next: any = { ...config };
  next.ldapUrl = String(next.ldapUrl || next.serverUrl || "");
  next.serverUrl = String(next.serverUrl || next.ldapUrl || "");
  next.managerDn = String(next.managerDn || next.bindDn || "");
  next.bindDn = String(next.bindDn || next.managerDn || "");
  next.managerPassword = String(next.managerPassword || next.bindPassword || "");
  next.bindPassword = String(next.bindPassword || next.managerPassword || "");
  next.searchBase = String(next.searchBase || next.baseDn || getBaseDnFromLdapUrl(next.ldapUrl) || "");
  next.baseDn = String(next.baseDn || next.searchBase || "");
  next.searchFilter = String(next.searchFilter || next.userSearchFilter || "");
  next.userSearchFilter = String(next.userSearchFilter || next.searchFilter || "");
  next.emailAttribute = String(next.emailAttribute || "mail");
  return next;
}

function normalizeAppConfig(app: AppConfig["app"]): AppConfig["app"] {
  const localUserEmailDomain = String(app.localUserEmailDomain || "")
    .trim()
    .replace(/^@+/, "");
  return {
    ...app,
    enableHTTPS: normalizeBoolean(app.enableHTTPS),
    httpsPort: normalizeNumber(app.httpsPort),
    validDays: normalizeNumber(app.validDays),
    sessionTimeoutMinutes: normalizeNumber(app.sessionTimeoutMinutes, 60),
    localUserEmailDomain,
  };
}

function hashProxyApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

function sanitizeProxyApiKeys(keys: any[] = []) {
  return keys
    .filter((key) => key && typeof key === "object")
    .map((key) => ({
      id: String(key.id || `key_${Date.now()}_${Math.floor(Math.random() * 1000)}`),
      name: String(key.name || "Proxy API Key").trim(),
      keyHash: String(key.keyHash || ""),
      createdOn: String(key.createdOn || new Date().toISOString()),
      revokedOn: key.revokedOn ? String(key.revokedOn) : "",
    }))
    .filter((key) => key.keyHash && !key.revokedOn);
}

function normalizeS3Config(s3: AppConfig["s3"]): AppConfig["s3"] {
  return {
    ...s3,
    enableSSL: normalizeBoolean(s3.enableSSL),
    verifyCertificates: normalizeBoolean(s3.verifyCertificates),
    forcePathStyle: normalizeBoolean(s3.forcePathStyle),
    proxyAuthEnabled: normalizeBoolean((s3 as any).proxyAuthEnabled),
    proxyAuthMethod: (s3 as any).proxyAuthMethod === "apiKey" ? "apiKey" : "basic",
    proxyBasicUsername: String((s3 as any).proxyBasicUsername || "").trim(),
    proxyApiKeys: sanitizeProxyApiKeys((s3 as any).proxyApiKeys),
  };
}

function parseS3EndpointUrl(endpointUrl: string) {
  const trimmed = endpointUrl.trim();
  if (!trimmed) throw new Error("S3 endpoint URL is required.");

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("S3 endpoint URL must start with http:// or https://.");
    }
    if (!parsed.hostname) {
      throw new Error("S3 endpoint URL must include a hostname.");
    }
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("S3 endpoint URL port must be a number between 1 and 65535.");
      }
    }
    return parsed;
  } catch {
    const portMatch = trimmed.match(/^https?:\/\/[^/?#]+:(\d*[^/?#\d][^/?#]*)/i);
    if (portMatch) {
      throw new Error("S3 endpoint URL port must contain only digits.");
    }
    const numericPortMatch = trimmed.match(/^https?:\/\/[^/?#]+:(\d+)/i);
    if (numericPortMatch) {
      const port = Number(numericPortMatch[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("S3 endpoint URL port must be a number between 1 and 65535.");
      }
    }
    throw new Error("S3 endpoint URL is invalid.");
  }
}

function validateS3Config(config: AppConfig["s3"]) {
  if (config.endpointUrl) {
    parseS3EndpointUrl(config.endpointUrl);
  }
  if (!String(config.bucketName || "").trim()) {
    throw new Error("S3 bucket name is required.");
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureDownloadTempDir() {
  if (!fs.existsSync(DOWNLOAD_TEMP_DIR)) {
    fs.mkdirSync(DOWNLOAD_TEMP_DIR, { recursive: true });
  }
}

function cleanupTempFile(filePath: string) {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.warn(`[S3-TEMP] Failed to remove temporary download file ${filePath}: ${err.message}`);
    }
  });
}

function getTempDownloadPath(fileName: string) {
  ensureDownloadTempDir();
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_") || "download.bin";
  return path.join(DOWNLOAD_TEMP_DIR, `${Date.now()}-${randomBytes(6).toString("hex")}-${safeName}`);
}

function sendTempDownload(res: express.Response, filePath: string, fileName: string, contentType: string) {
  const cleanup = () => cleanupTempFile(filePath);
  res.setHeader("Content-Type", contentType);
  res.download(filePath, fileName, (err) => {
    cleanup();
    if (err && !res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });
  res.on("close", cleanup);
}

function ensureConfigFile() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_PATH)) return;

  if (CONFIG_TEMPLATE_PATH !== CONFIG_PATH && fs.existsSync(CONFIG_TEMPLATE_PATH)) {
    fs.copyFileSync(CONFIG_TEMPLATE_PATH, CONFIG_PATH);
    console.log(`[CONFIG] Seeded runtime config at ${CONFIG_PATH} from ${CONFIG_TEMPLATE_PATH}`);
    return;
  }

  fs.writeFileSync(CONFIG_PATH, yaml.dump(DEFAULT_CONFIG, { lineWidth: -1, noRefs: true }), "utf8");
  console.log(`[CONFIG] Created first-run runtime config at ${CONFIG_PATH}`);
}

function loadConfig(): AppConfig {
  try {
    ensureConfigFile();
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const loaded = (yaml.load(raw) as Partial<AppConfig>) || {};
    const merged = mergeConfig(loaded);
    if (merged.ldap.serverUrl.includes("ldap.corp.internal")) {
      const migrated = mergeConfig({ ...merged, ldap: DEFAULT_CONFIG.ldap });
      fs.writeFileSync(CONFIG_PATH, yaml.dump(migrated, { lineWidth: -1, noRefs: true }), "utf8");
      console.log(`[CONFIG] Migrated default LDAP settings to local LDAPS directory at ${DEFAULT_CONFIG.ldap.serverUrl}`);
      return migrated;
    }
    return merged;
  } catch (err: any) {
    console.warn(`[CONFIG] Failed to read config.yaml, using defaults: ${err.message}`);
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: Partial<AppConfig>): AppConfig {
  ensureConfigFile();
  const merged = mergeConfig(config);
  fs.writeFileSync(CONFIG_PATH, yaml.dump(merged, { lineWidth: -1, noRefs: true }), "utf8");
  return merged;
}

function getPrimaryEsUrl(config: AppConfig["elasticsearch"]): string {
  return config.nodeUrls.split(",").map((url) => url.trim()).filter(Boolean)[0] || DEFAULT_CONFIG.elasticsearch.nodeUrls;
}

function getEsAuth(config: AppConfig["elasticsearch"]): string | undefined {
  if (config.authMethod === "token" && config.token) return `ApiKey ${config.token}`;
  if (config.authMethod === "basic" && config.username && config.password) {
    return "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }
  return undefined;
}

function esHeaders(extra: Record<string, string> = {}) {
  const auth = ES_AUTH ? { Authorization: ES_AUTH } : {};
  return { ...auth, ...extra };
}

function createTlsOptions(config: {
  enableSSL?: boolean;
  verifyCertificates?: boolean;
  verifyServerCertificate?: boolean;
  caCertificateContent?: string;
  clientCertificateContent?: string;
  clientKeyContent?: string;
}) {
  const rejectUnauthorized =
    config.verifyServerCertificate ?? config.verifyCertificates ?? true;
  const ca = config.caCertificateContent?.trim() || undefined;
  const cert = config.clientCertificateContent?.trim() || undefined;
  const key = config.clientKeyContent?.trim() || undefined;
  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
  };
}

function createEsDispatcher(config: AppConfig["elasticsearch"]): Dispatcher | undefined {
  const url = getPrimaryEsUrl(config);
  if (!config.enableSSL && !url.startsWith("https://")) return undefined;
  return new UndiciAgent({
    connect: createTlsOptions(config),
  });
}

function esFetch(input: string, init: RequestInit = {}) {
  const dispatcher = esFetchDispatcher;
  return fetch(input, {
    ...init,
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit & { dispatcher?: Dispatcher });
}

function escapeQueryStringValue(value: string) {
  return value.replace(/([+\-=!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}

function buildFieldValueQuery(field: string, value: string) {
  if (field === "_id" || field === "id") {
    return {
      bool: {
        should: [
          { ids: { values: [value] } },
          { term: { _id: value } },
          { term: { id: value } },
          { term: { "id.keyword": value } },
        ],
        minimum_should_match: 1,
      },
    };
  }

  const numericValue = Number(value);
  const should: any[] = [
    { match_phrase: { [field]: value } },
    { term: { [field]: value } },
    { term: { [`${field}.keyword`]: value } },
    {
      wildcard: {
        [`${field}.keyword`]: {
          value: `*${value}*`,
          case_insensitive: true,
        },
      },
    },
  ];

  if (value.toLowerCase() !== value) {
    should.push({ term: { [field]: value.toLowerCase() } });
    should.push({ term: { [`${field}.keyword`]: value.toLowerCase() } });
  }

  if (Number.isFinite(numericValue) && value.trim() !== "") {
    should.push({ term: { [field]: numericValue } });
  }

  return {
    bool: {
      should,
      minimum_should_match: 1,
    },
  };
}

function buildGlobalValueQuery(value: string) {
  const escapedValue = escapeQueryStringValue(value);
  const numericValue = Number(value);
  const should: any[] = [
    {
      query_string: {
        query: `*${escapedValue}*`,
        fields: ["*"],
        default_operator: "and",
        analyze_wildcard: true,
        lenient: true,
      },
    },
    {
      query_string: {
        query: escapedValue,
        fields: ["*"],
        default_operator: "and",
        analyze_wildcard: true,
        lenient: true,
      },
    },
    {
      multi_match: {
        query: value,
        fields: ["*"],
        type: "phrase",
        lenient: true,
      },
    },
  ];

  if (Number.isFinite(numericValue) && value.trim() !== "") {
    ["bytes", "status", "size_bytes"].forEach((field) => {
      should.push({ term: { [field]: numericValue } });
    });
  }

  return {
    bool: {
      should,
      minimum_should_match: 1,
    },
  };
}

function stripElasticsearchMetadata(doc: Record<string, unknown>) {
  const { _id, _index, _score, _type, ...source } = doc;
  return source;
}

function normalizeWritableIndexName(value: unknown) {
  const indexName = String(value || "").trim();
  if (!indexName) return "";
  if (indexName.includes("*")) {
    throw new Error("Wildcard index patterns are not valid write targets. Choose a concrete index name.");
  }
  return indexName;
}

let runtimeConfig = loadConfig();
let globalS3Config = runtimeConfig.s3;

// Helper function to dynamically initialize real S3 client or fallback
const getS3Client = (overrideConfig?: AppConfig["s3"]) => {
  if (!overrideConfig) {
    refreshRuntimeConfig();
  }
  const config = overrideConfig || globalS3Config;
  validateS3Config(config);
  const s3Params: any = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  };

  if (config.endpointUrl) {
    s3Params.endpoint = parseS3EndpointUrl(config.endpointUrl).toString();
  }

  if (config.enableSSL || config.endpointUrl?.startsWith("https://")) {
    s3Params.requestHandler = new NodeHttpHandler({
      httpsAgent: new https.Agent(createTlsOptions(config)),
    });
  }

  return new S3Client(s3Params);
};

let globalAuditConfig = runtimeConfig.audit;
let globalDiscoverConfig = runtimeConfig.discover;

function getS3CatalogIndex(config: AppConfig["s3"] = globalS3Config) {
  return config.catalogIndex || "";
}

// In-Memory simulated Elasticsearch Indexes database schema for Seclog auditor compliance
interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: "LOGIN" | "DOWNLOAD" | "UPLOAD" | "CONFIG_CHANGE";
  username: string;
  details: string;
  index: string;
  ip: string;
}

type LocalUserRecord = {
  id: string;
  username: string;
  password: string;
  fullName: string;
  email: string;
  role: "super_admin" | "observer";
  type: "local";
  createdOn: string;
  department?: string;
};

function createInitialLocalUsers(): LocalUserRecord[] {
  const createdOn = new Date().toISOString().slice(0, 10);
  const emailDomain = DEFAULT_CONFIG.app.localUserEmailDomain;
  return [
    {
      id: "u_101",
      username: "admin",
      password: randomBytes(12).toString("hex"),
      fullName: "ING Release Logs Administrator",
      email: emailDomain ? `admin@${emailDomain}` : "",
      role: "super_admin",
      type: "local",
      createdOn,
      department: "Azure DevOps",
    },
    {
      id: "u_102",
      username: "devops",
      password: randomBytes(12).toString("hex"),
      fullName: "app viewer",
      email: emailDomain ? `devops@${emailDomain}` : "",
      role: "observer",
      type: "local",
      createdOn,
      department: "Azure DevOps",
    },
  ];
}

function ensureLocalUsersFile() {
  ensureDataDir();
  if (!fs.existsSync(LOCAL_USERS_PATH)) {
    fs.writeFileSync(LOCAL_USERS_PATH, JSON.stringify(createInitialLocalUsers(), null, 2), "utf8");
    console.log(`[AUTH] Created first-run local user credentials at ${LOCAL_USERS_PATH}`);
  }
}

function readLocalUsers(): LocalUserRecord[] {
  ensureLocalUsersFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_USERS_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((user) => ({
      ...user,
      role: user.role === "kibana_admin" ? "super_admin" : user.role,
    }));
  } catch (err: any) {
    console.error(`[AUTH] Failed to read local users file: ${err.message}`);
    return [];
  }
}

function saveLocalUsers(users: LocalUserRecord[]) {
  ensureLocalUsersFile();
  fs.writeFileSync(LOCAL_USERS_PATH, JSON.stringify(users, null, 2), "utf8");
}

function publicUser(user: LocalUserRecord) {
  const { password, ...safeUser } = user;
  return safeUser;
}

function getCookie(req: express.Request, name: string) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return "";
}

function getAppSession(req: express.Request) {
  const token = getCookie(req, APP_SESSION_COOKIE);
  if (!token) return null;
  const session = appSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    appSessions.delete(token);
    return null;
  }
  return session;
}

function getDownloadAuditUsername(req: express.Request, requestedUsername: unknown) {
  return getAppSession(req)?.username || String(requestedUsername || "").trim() || "Anonymous";
}

function setAppSessionCookie(res: express.Response, username: string) {
  const timeoutMinutes = Math.max(5, Number(runtimeConfig.app.sessionTimeoutMinutes) || 60);
  const maxAgeSeconds = timeoutMinutes * 60;
  const token = randomBytes(32).toString("hex");
  appSessions.set(token, { username, expiresAt: Date.now() + maxAgeSeconds * 1000 });
  const secure = runtimeConfig.app.enableHTTPS ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearAppSessionCookie(req: express.Request, res: express.Response) {
  const token = getCookie(req, APP_SESSION_COOKIE);
  if (token) appSessions.delete(token);
  const secure = runtimeConfig.app.enableHTTPS ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${APP_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function getRequestBearerOrApiKey(req: express.Request) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const headerKey = req.headers["x-api-key"];
  if (Array.isArray(headerKey)) return headerKey[0] || "";
  if (headerKey) return String(headerKey).trim();
  return String(req.query.apiKey || req.query.api_key || "").trim();
}

function validateS3ProxyDownloadAuth(req: express.Request, res: express.Response) {
  const config = globalS3Config as any;
  if (!config.proxyAuthEnabled) return true;
  if (getAppSession(req)) return true;

  if (config.proxyAuthMethod === "apiKey") {
    const apiKey = getRequestBearerOrApiKey(req);
    const apiKeyHash = apiKey ? hashProxyApiKey(apiKey) : "";
    const found = sanitizeProxyApiKeys(config.proxyApiKeys).some((key) => !key.revokedOn && key.keyHash === apiKeyHash);
    if (found) return true;
    res.status(401).json({ error: "A valid S3 proxy API key is required." });
    return false;
  }

  const auth = String(req.headers.authorization || "");
  if (!auth.toLowerCase().startsWith("basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Release Logs S3 Proxy"');
    res.status(401).send("Basic authentication required.");
    return false;
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";
  const allowedUsername = String(config.proxyBasicUsername || "").trim().toLowerCase();
  const user = readLocalUsers().find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
  if (user && (!allowedUsername || user.username.toLowerCase() === allowedUsername) && user.password === password) {
    return true;
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Release Logs S3 Proxy"');
  res.status(401).send("Invalid S3 proxy credentials.");
  return false;
}

type AuthenticatedUserRecord = Omit<LocalUserRecord, "password"> | {
  id: string;
  username: string;
  fullName: string;
  email: string;
  role: "observer";
  type: "ldap";
  createdOn: string;
  department?: string;
};

function ldapEncodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function ldapTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), ldapEncodeLength(value.length), value]);
}

function getLdapUrl(config: AppConfig["ldap"]) {
  return String((config as any).ldapUrl || config.serverUrl || "");
}

function parseLdapUrl(ldapUrl: string) {
  const trimmed = ldapUrl.trim();
  if (!trimmed) throw new Error("LDAP URL is required.");

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ldap:" && parsed.protocol !== "ldaps:") {
      throw new Error("LDAP URL must start with ldap:// or ldaps://.");
    }
    if (!parsed.hostname) {
      throw new Error("LDAP URL must include a hostname.");
    }
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("LDAP URL port must be a number between 1 and 65535.");
      }
    }
    return parsed;
  } catch {
    const portMatch = trimmed.match(/^ldaps?:\/\/[^/?#]+:(\d*[^/?#\d][^/?#]*)/i);
    if (portMatch) {
      throw new Error("LDAP URL port must contain only digits.");
    }
    throw new Error("LDAP URL is invalid.");
  }
}

function getLdapConnectionUrl(config: AppConfig["ldap"]) {
  const parsed = parseLdapUrl(getLdapUrl(config));
  return `${parsed.protocol}//${parsed.host}`;
}

function getBaseDnFromLdapUrl(ldapUrl: string) {
  try {
    const parsed = parseLdapUrl(ldapUrl);
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

function getLdapSearchBases(config: AppConfig["ldap"]) {
  const rawBase = String((config as any).searchBase || config.baseDn || getBaseDnFromLdapUrl(getLdapUrl(config)) || "");
  return rawBase
    .split("|")
    .map((base) => base.trim())
    .filter(Boolean);
}

function getLdapManagerDn(config: AppConfig["ldap"]) {
  return String((config as any).managerDn || config.bindDn || "");
}

function getLdapManagerPassword(config: AppConfig["ldap"]) {
  return String((config as any).managerPassword || config.bindPassword || "");
}

function formatLdapFilter(template: string, username: string) {
  const escapedUsername = ldapEscapeFilterValue(username);
  return template
    .replace(/\{0\}/g, escapedUsername)
    .replace(/\{username\}/g, escapedUsername);
}

function formatUserDnPattern(pattern: string, username: string) {
  return pattern
    .replace(/\{0\}/g, username)
    .replace(/\{username\}/g, username);
}

function buildLdapClient(config: AppConfig["ldap"]) {
  const tlsOptions: any = {};
  if (!config.verifyCertificates) {
    tlsOptions.rejectUnauthorized = false;
  }
  if (config.caCertificateContent?.trim()) {
    tlsOptions.ca = [config.caCertificateContent];
  }
  return new Client({ url: getLdapConnectionUrl(config), tlsOptions });
}

async function ldapBind(config: AppConfig["ldap"], dn: string, password: string) {
  const client = buildLdapClient(config);
  try {
    await client.bind(dn, password);
  } finally {
    await client.unbind().catch(() => null);
  }
}

async function ldapSearch(config: AppConfig["ldap"], baseDn: string, filter: string, attributes: string[]) {
  const client = buildLdapClient(config);
  try {
    const managerDn = getLdapManagerDn(config);
    if (managerDn) {
      await client.bind(managerDn, getLdapManagerPassword(config));
    }
    const { searchEntries } = await client.search(baseDn, {
      scope: "sub",
      filter,
      attributes,
    });
    return (searchEntries as any[]).map((entry) => {
      const attrs: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (key === "dn") continue;
        if (Array.isArray(value)) {
          attrs[key] = value.map((item) => String(item));
        } else if (value != null) {
          attrs[key] = [String(value)];
        }
      }
      return { dn: entry.dn as string, attrs };
    });
  } finally {
    await client.unbind().catch(() => null);
  }
}

function ldapEscapeFilterValue(value: string) {
  return value
    .replace(/\\/g, "\\5c")
    .replace(/\*/g, "\\2a")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\0/g, "\\00");
}

async function authenticateLdapUserWithConfig(config: AppConfig["ldap"], username: string, password: string): Promise<AuthenticatedUserRecord> {
  const userDnPattern = String((config as any).userDnPattern || "").trim();
  const emailAttribute = String((config as any).emailAttribute || "mail").trim() || "mail";
  const userFilterTemplate = String((config as any).searchFilter || config.userSearchFilter || "(uid={0})").trim();
  const searchBases = getLdapSearchBases(config);

  let user: { dn: string; attrs: Record<string, string[]> } | null = null;
  if (userDnPattern) {
    user = { dn: formatUserDnPattern(userDnPattern, username), attrs: {} };
  } else {
    if (getLdapManagerDn(config)) {
      await ldapBind(config, getLdapManagerDn(config), getLdapManagerPassword(config));
    }
    const userFilter = formatLdapFilter(userFilterTemplate, username);
    for (const base of searchBases) {
      const users = await ldapSearch(config, base, userFilter, ["cn", "displayName", emailAttribute, "mail", "uid", "sAMAccountName", "memberOf"]);
      if (users[0]) {
        user = users[0];
        break;
      }
    }
  }
  if (!user) throw new Error("LDAP user not found.");
  await ldapBind(config, user.dn, password);

  const groupFilter = String(config.groupSearchFilter || "").trim();
  if (groupFilter) {
    const escapedUsername = ldapEscapeFilterValue(username);
    const concreteFilter = groupFilter
      .replace(/\{username\}/g, escapedUsername)
      .replace(/\{0\}/g, escapedUsername)
      .replace(/\{userDn\}/g, ldapEscapeFilterValue(user.dn));
    const groupMatches = (await Promise.all(
      searchBases.map((base) => ldapSearch(config, base, concreteFilter, ["dn", "cn"]).catch(() => []))
    )).flat();
    if (groupMatches.length === 0) throw new Error("LDAP user is not in an allowed group.");
  }

  const fullName = user.attrs.displayName?.[0] || user.attrs.cn?.[0] || username;
  const email = user.attrs[emailAttribute]?.[0] || user.attrs.mail?.[0] || "";
  return {
    id: `ldap_${username}`,
    username,
    fullName,
    email,
    role: "observer",
    type: "ldap",
    createdOn: new Date().toISOString().slice(0, 10),
    department: "LDAP Directory",
  };
}

async function authenticateLdapUser(username: string, password: string): Promise<AuthenticatedUserRecord> {
  return authenticateLdapUserWithConfig(loadConfig().ldap, username, password);
}

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derSeq(...parts: Buffer[]): Buffer {
  return der(0x30, ...parts);
}

function derSet(...parts: Buffer[]): Buffer {
  return der(0x31, ...parts);
}

function derInt(value: number | Buffer): Buffer {
  let body: Buffer;
  if (Buffer.isBuffer(value)) {
    body = value;
  } else {
    const bytes: number[] = [];
    let remaining = value;
    do {
      bytes.unshift(remaining & 0xff);
      remaining >>= 8;
    } while (remaining > 0);
    body = Buffer.from(bytes);
  }
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return der(0x02, body);
}

function derBool(value: boolean): Buffer {
  return der(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derBitString(value: Buffer): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function derOctetString(value: Buffer): Buffer {
  return der(0x04, value);
}

function derUtf8(value: string): Buffer {
  return der(0x0c, Buffer.from(value, "utf8"));
}

function derUtcTime(date: Date): Buffer {
  const year = date.getUTCFullYear() % 100;
  const pad = (n: number) => String(n).padStart(2, "0");
  const value = `${pad(year)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(value, "ascii"));
}

function derOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

function derNull(): Buffer {
  return der(0x05);
}

function algorithmIdentifier(): Buffer {
  return derSeq(derOid("1.2.840.113549.1.1.11"), derNull());
}

function commonName(name: string): Buffer {
  return derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(name))));
}

function extension(oid: string, value: Buffer, critical = false): Buffer {
  return derSeq(
    derOid(oid),
    ...(critical ? [derBool(true)] : []),
    derOctetString(value)
  );
}

function createSelfSignedCertificate(commonNameValue: string, validDays: number) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKeyDer = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey);
  const privateKeyPem = privateKey.toString();
  const now = new Date();
  const notAfter = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);
  const serial = randomBytes(16);
  const subject = commonName(commonNameValue || "localhost");
  const san = derSeq(
    der(0x82, Buffer.from(commonNameValue || "localhost", "ascii")),
    der(0x82, Buffer.from("localhost", "ascii")),
    der(0x87, Buffer.from([127, 0, 0, 1]))
  );
  const extensions = der(0xa3, derSeq(
    extension("2.5.29.19", derSeq(derBool(false)), true),
    extension("2.5.29.15", derBitString(Buffer.from([0xa0])), true),
    extension("2.5.29.37", derSeq(derOid("1.3.6.1.5.5.7.3.1"))),
    extension("2.5.29.17", san)
  ));
  const tbs = derSeq(
    der(0xa0, derInt(2)),
    derInt(serial),
    algorithmIdentifier(),
    subject,
    derSeq(derUtcTime(now), derUtcTime(notAfter)),
    subject,
    publicKeyDer,
    extensions
  );
  const signature = createSign("RSA-SHA256").update(tbs).end().sign(privateKeyPem);
  const certDer = derSeq(tbs, algorithmIdentifier(), derBitString(signature));
  const certBase64 = certDer.toString("base64").match(/.{1,64}/g)?.join("\n") || "";
  return {
    certificateContent: `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----\n`,
    privateKeyContent: privateKeyPem,
  };
}

function ensureAppCertificate(config = loadConfig()): AppConfig {
  if (!config.app.enableHTTPS) return config;
  if (config.app.certificateContent && config.app.privateKeyContent) return config;
  const generated = createSelfSignedCertificate(config.app.commonName, config.app.validDays);
  const next = saveConfig({
    ...config,
    app: {
      ...config.app,
      certificateContent: generated.certificateContent,
      privateKeyContent: generated.privateKeyContent,
    },
  });
  console.log(`[TLS] Created self-signed app certificate in config.yaml for CN=${next.app.commonName}`);
  return next;
}

let auditLogsDb: AuditLogEntry[] = [];

let ES_URL = getPrimaryEsUrl(runtimeConfig.elasticsearch);
let ES_AUTH = getEsAuth(runtimeConfig.elasticsearch);
let esFetchDispatcher = createEsDispatcher(runtimeConfig.elasticsearch);

function refreshRuntimeConfig() {
  runtimeConfig = loadConfig();
  globalS3Config = runtimeConfig.s3;
  globalAuditConfig = runtimeConfig.audit;
  globalDiscoverConfig = runtimeConfig.discover;
  ES_URL = getPrimaryEsUrl(runtimeConfig.elasticsearch);
  ES_AUTH = getEsAuth(runtimeConfig.elasticsearch);
  esFetchDispatcher = createEsDispatcher(runtimeConfig.elasticsearch);
}

async function createMockZipBuffer(label: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "README.txt",
    `Mock archive: ${label}\nGenerated: ${new Date().toISOString()}\nSource: elastic-kibana-logs / MinIO`
  );
  zip.file(
    "logs/sample.log",
    `[${new Date().toISOString()}] INFO Sample log line bundled in ${label}\n`
  );
  zip.file(
    "manifest.json",
    JSON.stringify({ archive: label, type: "mock-telemetry-bundle", version: "1.0" }, null, 2)
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function fetchS3ObjectBuffer(key: string): Promise<Buffer> {
  try {
    const s3 = getS3Client();
    const result = await s3.send(
      new GetObjectCommand({ Bucket: globalS3Config.bucketName, Key: key })
    );
    if (result.Body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
  } catch {
    // fall through to sandbox
  }

  const safeKey = key.replace(/\//g, "_");
  const filePath = path.join(SANDBOX_STORAGE_DIR, safeKey);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }

  return createMockZipBuffer(key);
}

/** Optional descriptions for S3 objects (uploaded or edited via UI) */
const s3FileMetadata: Record<string, { description?: string }> = {};

function inferContentType(key: string): string {
  if (key.endsWith(".zip")) return "application/zip";
  if (key.endsWith(".pdf")) return "application/pdf";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".gz")) return "application/gzip";
  return "application/octet-stream";
}

function restoreSandboxKey(filename: string): string {
  if (filename.startsWith("snaps_")) return filename.replace(/^snaps_/, "snaps/");
  if (filename.startsWith("audits_")) return filename.replace(/^audits_/, "audits/");
  if (filename.startsWith("incidents_")) return filename.replace(/^incidents_/, "incidents/");
  if (filename.startsWith("archives_")) return filename.replace(/^archives_/, "archives/");
  return filename;
}

function normalizeS3ObjectKey(key: string) {
  return key
    .trim()
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => part.replace(/\s+/g, ""))
    .filter(Boolean)
    .join("/");
}

function listSandboxS3Files(): S3ListedFile[] {
  if (!fs.existsSync(SANDBOX_STORAGE_DIR)) return [];
  return fs.readdirSync(SANDBOX_STORAGE_DIR).map((filename) => {
    const key = restoreSandboxKey(filename);
    const filePath = path.join(SANDBOX_STORAGE_DIR, filename);
    const stat = fs.statSync(filePath);
    return {
      key,
      size: stat.size,
      lastModified: stat.mtime.toISOString(),
      contentType: inferContentType(key),
    };
  });
}

async function listAllS3Files(): Promise<{ files: S3ListedFile[]; source: string }> {
  if (globalS3Config.bucketName) {
    try {
      const s3 = getS3Client();
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: globalS3Config.bucketName,
          MaxKeys: 500,
        })
      );

      if (response?.Contents && response.Contents.length > 0) {
        const files = response.Contents.filter((obj) => obj.Key).map((obj) => ({
          key: obj.Key!,
          size: obj.Size || 0,
          lastModified: obj.LastModified ? obj.LastModified.toISOString() : new Date().toISOString(),
          contentType: inferContentType(obj.Key!),
        }));
        return { files, source: "real-s3" };
      }

      return { files: [], source: "real-s3" };
    } catch (err: any) {
      console.warn(`[S3-LIST] S3 bucket unavailable (${err.name || "Error"}: ${err.message}). Falling back to sandbox objects.`);
    }
  }

  return { files: listSandboxS3Files(), source: "sandbox-simulation-storage" };
}

async function bulkIndexToElasticsearch(
  docs: { _index: string; _id: string; body: Record<string, unknown> }[]
): Promise<boolean> {
  if (docs.length === 0) return true;
  let bulkBody = "";
  for (const doc of docs) {
    bulkBody += JSON.stringify({ index: { _index: doc._index, _id: doc._id } }) + "\n";
    bulkBody += JSON.stringify(stripElasticsearchMetadata(doc.body)) + "\n";
  }
  try {
    const res = await esFetch(`${ES_URL}/_bulk?refresh=true`, {
      method: "POST",
      headers: esHeaders({ "Content-Type": "application/x-ndjson" }),
      body: bulkBody,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[ES-BULK] HTTP ${res.status}: ${text.slice(0, 300)}`);
      return false;
    }
    const result = await res.json();
    if (result.errors) {
      const errs = result.items?.filter((it: any) => it.index?.error)?.slice(0, 3);
      console.error(`[ES-BULK] Index errors:`, JSON.stringify(errs));
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[ES-BULK] Failed:`, err.message);
    return false;
  }
}

async function syncS3CatalogToElasticsearch(force = false): Promise<{ count: number; source: string }> {
  const catalogIndex = getS3CatalogIndex();
  if (!catalogIndex) {
    console.warn("[ES-CATALOG-WARN] S3 catalog index is not configured in config.yaml.");
    return { count: 0, source: "unconfigured" };
  }

  const { files, source } = await listAllS3Files();
  const zipAndArchives = files.filter(
    (f) =>
      f.key.endsWith(".zip") ||
      f.key.endsWith(".gz") ||
      f.key.startsWith("snaps/") ||
      f.key.startsWith("archives/")
  );
  const catalogFiles = zipAndArchives.length > 0 ? zipAndArchives : files;

  const catalogLogs = catalogFiles.map((file) =>
    buildCatalogLogFromS3File(file, catalogIndex, s3FileMetadata[file.key]?.description)
  );

  globalSessionLogs = [
    ...catalogLogs,
    ...globalSessionLogs.filter((l: any) => l._index !== catalogIndex),
  ];

  try {
    const countRes = await esFetch(`${ES_URL}/${encodeURIComponent(catalogIndex)}/_count`, {
      headers: esHeaders(),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const existingCount = countRes && typeof countRes.count === "number" ? countRes.count : 0;

    if (!force && existingCount >= catalogLogs.length && catalogLogs.length > 0) {
      console.log(`[ES-CATALOG] Index has ${existingCount} docs (expected ~${catalogLogs.length}). Skipping sync.`);
      return { count: existingCount, source };
    }

    const ok = await bulkIndexToElasticsearch(
      catalogLogs.map((log) => ({
        _index: catalogIndex,
        _id: log._id,
        body: { ...log },
      }))
    );

    if (ok) {
      console.log(`[ES-CATALOG] Synced ${catalogLogs.length} documents into [${catalogIndex}] (source: ${source}).`);
      return { count: catalogLogs.length, source };
    }
  } catch (err: any) {
    console.warn(`[ES-CATALOG-WARN] Sync failed:`, err.message);
  }

  return { count: catalogLogs.length, source: "memory-fallback" };
}

async function deleteCatalogDocForKey(key: string) {
  const catalogIndex = getS3CatalogIndex();
  if (!catalogIndex) return;

  const docId = s3KeyToDocId(key);
  await esFetch(`${ES_URL}/${encodeURIComponent(catalogIndex)}/_doc/${encodeURIComponent(docId)}`, {
    method: "DELETE",
    headers: esHeaders(),
  }).catch(() => null);
  globalSessionLogs = globalSessionLogs.filter(
    (l: any) => !(l._index === catalogIndex && l._id === docId)
  );
}

async function indexAuditLogToElasticsearch(log: AuditLogEntry) {
  try {
    const targetIndex = log.index || globalAuditConfig.elasticsearchIndex;
    if (!targetIndex) {
      console.warn("[ES-AUDIT-WRITE-WARN] Audit index is not configured in config.yaml. Skipping Elasticsearch audit write.");
      return;
    }
    console.log(`[ES-AUDIT-WRITE] Indexing document to Elasticsearch: PUT ${ES_URL}/${targetIndex}/_doc/${log.id}`);

    const res = await esFetch(`${ES_URL}/${targetIndex}/_doc/${log.id}?refresh=true`, {
      method: "PUT",
      headers: esHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(log)
    });

    if (res.ok) {
      console.log(`[ES-AUDIT-WRITE] Successfully put audit document ${log.id} details to ES index ${targetIndex}.`);
    } else {
      const errText = await res.text().catch(() => "");
      console.error(`[ES-AUDIT-WRITE-WARN] Failed to write document ${log.id} to ES index ${targetIndex}: ${res.status} - ${errText}`);
    }
  } catch (err: any) {
    console.error(`[ES-AUDIT-WRITE-ERR] Elasticsearch document PUT failed:`, err.message);
  }
}

let globalSessionLogs: any[] = [];

async function initElasticsearch() {
  try {
    const health = await esFetch(`${ES_URL}/_cluster/health`, {
      headers: esHeaders()
    }).then(res => res.json()).catch(() => null);

    if (health && (health.status === "green" || health.status === "yellow")) {
      console.log(`[ES] Connected to Elasticsearch. Cluster status: ${health.status}`);

      // 1. Force adjust cluster settings to avoid disk watermark blocks in full sandbox container
      try {
        const configClusterRes = await esFetch(`${ES_URL}/_cluster/settings`, {
          method: "PUT",
          headers: esHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            persistent: {
              "cluster.routing.allocation.disk.threshold_enabled": false
            },
            transient: {
              "cluster.routing.allocation.disk.threshold_enabled": false
            }
          })
        }).then(r => r.json());
        console.log(`[ES-INIT] Adjusted disk threshold block configuration:`, JSON.stringify(configClusterRes));
      } catch (settingsErr: any) {
        console.warn(`[ES-INIT-WARN] Could not adjust cluster disk settings:`, settingsErr.message);
      }

      // 2. Unblock any read-only allow delete states
      try {
        const unblockRes = await esFetch(`${ES_URL}/_all/_settings`, {
          method: "PUT",
          headers: esHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            "index.blocks.read_only_allow_delete": null
          })
        }).then(r => r.json());
        console.log(`[ES-INIT] Cleared read_only_allow_delete blocks on index settings:`, JSON.stringify(unblockRes));
      } catch (unblockErr: any) {
        console.warn(`[ES-INIT-WARN] Could not clear index blocks:`, unblockErr.message);
      }

      console.log(`[ES] Connected. Shards & index parameters unblocked.`);

    } else {
      console.warn(`[ES] Elasticsearch not available at ${ES_URL}, skipping initialization.`);
    }
  } catch (err) {
    console.error(`[ES] Error initializing Elasticsearch:`, (err as any).message);
  }
}

async function initMinIO() {
  try {
    const s3 = getS3Client();
    let realS3Seeded = 0;
    let sandboxSeeded = 0;
    for (const f of MOCK_FILES_DB) {
      try {
        const checkCmd = new GetObjectCommand({ Bucket: globalS3Config.bucketName, Key: f.key });
        await s3.send(checkCmd);
        realS3Seeded += 1;
      } catch (err) {
        console.log(`[S3-INIT] Seeding MinIO object: ${f.key}`);
        const body =
          f.contentType === "application/zip"
            ? await createMockZipBuffer(f.key)
            : Buffer.from(
                `[MINIO CLUSTER DATA ${f.key}]\n- Size: ${f.size}\n- Timestamp: ${f.lastModified}\n- Content: Decrypted private telemetry package.`
              );
        const putCmd = new PutObjectCommand({
          Bucket: globalS3Config.bucketName,
          Key: f.key,
          Body: body,
          ContentType: f.contentType,
        });
        await s3.send(putCmd)
          .then(() => {
            realS3Seeded += 1;
          })
          .catch(() => {
            sandboxSeeded += 1;
            console.warn(`[S3-INIT] MinIO unreachable for ${f.key}; using sandbox fallback.`);
          });

        const safeKey = f.key.replace(/\//g, "_");
        const filePath = path.join(SANDBOX_STORAGE_DIR, safeKey);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, body);
      }
    }

    // Seed dynamically generated mock archive files into MinIO by querying ES first
    const esRes = await esFetch(`${ES_URL}/_all/_search?size=1000`, {
      headers: esHeaders()
    }).then(r => r.json()).catch(() => null);

    if (esRes && esRes.hits && esRes.hits.hits) {
      const logs = esRes.hits.hits.map((h: any) => h._source);
      for (const log of logs) {
        if (log.archive_name) {
          try {
            const checkCmd = new GetObjectCommand({ Bucket: globalS3Config.bucketName, Key: log.archive_name });
            await s3.send(checkCmd);
          } catch (err) {
            const body = log.archive_name.endsWith('.zip') || log.archive_name.endsWith('.gz')
              ? await createMockZipBuffer(log.archive_name)
              : Buffer.from(`[DOCKER MINIO PAYLOAD FOR ${log.archive_name}]\n- Timestamp: ${log.timestamp}\n- Event: ${log.request_path}\n- Source IP: ${log.ip}\n- Status: OK.`);
            const putCmd = new PutObjectCommand({
              Bucket: globalS3Config.bucketName,
              Key: log.archive_name,
              Body: body,
              ContentType: log.archive_name.endsWith('.zip') ? "application/zip" : "application/gzip",
            });
            await s3.send(putCmd)
              .then(() => {
                realS3Seeded += 1;
              })
              .catch(() => {
                sandboxSeeded += 1;
              });
          }
        }
      }
    }
    console.log(`[S3-INIT] Seed complete. real-s3=${realS3Seeded}, sandbox-fallback=${sandboxSeeded}.`);
  } catch (err) {
    console.warn(`[S3-INIT] Could not seed MinIO.`, (err as any).message);
  }
}

async function startServer() {
  ensureLocalUsersFile();
  ensureAppCertificate();

  const app = express();
  const PORT = 3000;

  // Launch independent Elasticsearch seeding background service asynchronously to populate data
  console.log("[MAIN-SERVER] Booting independent Elasticsearch initialization service in the background...");
  const initCmd = process.env.NODE_ENV === "production" ? "node dist/init-es.cjs" : "npm run init-es";

  const initProc = exec(initCmd, (err) => {
    if (err && err.code !== 0 && !err.message.includes('fetch failed')) {
      console.warn(`[MAIN-SERVER] Background initialization service logs:`, err.message);
    }
  });

  initProc.stdout?.on("data", (data) => {
    // Only log essential stdout, ignore spam
    const str = data.toString().trim();
    if (str.includes("SUCCESS") || str.includes("CRITICAL")) {
      console.log(`[ES-INIT-STDOUT] ${str}`);
    }
  });

  initProc.stderr?.on("data", (data) => {
    // Suppress fetch failed stderr
    const str = data.toString().trim();
    if (!str.includes("fetch failed") && !str.includes("ERR_MODULE_NOT_FOUND")) {
      console.error(`[ES-INIT-STDERR] ${str}`);
    }
  });

  // Initialize backend: ES settings → MinIO seeds → catalog index sync
  (async () => {
    try {
      await initElasticsearch();
      await initMinIO();
      await syncS3CatalogToElasticsearch(true);
    } catch (err: any) {
      console.warn(`[STARTUP-WARN] Optional backend initialization skipped: ${err.message}`);
    }
  })().catch((err: any) => {
    console.warn(`[STARTUP-WARN] Optional backend initialization failed: ${err.message}`);
  });

  // Medium Parser for Base64 log uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  app.use((_req, _res, next) => {
    refreshRuntimeConfig();
    next();
  });
  app.use((req, res, next) => {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const isHttpsRequest = req.secure || (req.socket as any).encrypted || forwardedProto === "https";

    if (!runtimeConfig.app.enableHTTPS || isHttpsRequest) {
      next();
      return;
    }

    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const hostname = String(hostHeader).split(":")[0];
    const portSuffix = runtimeConfig.app.httpsPort === 443 ? "" : `:${runtimeConfig.app.httpsPort}`;
    res.redirect(308, `https://${hostname}${portSuffix}${req.originalUrl}`);
  });

  // --- LOCAL AUTH / USERS ---
  app.post("/api/auth/login", async (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({ status: "error", error: "Username and password are required." });
    }

    const user = readLocalUsers().find((candidate) => candidate.username.toLowerCase() === username);
    if (user && user.password === password) {
      setAppSessionCookie(res, user.username);
      return res.json({ status: "success", user: publicUser(user) });
    }

    try {
      const ldapUser = await authenticateLdapUser(username, password);
      setAppSessionCookie(res, ldapUser.username);
      return res.json({ status: "success", user: ldapUser });
    } catch (err: any) {
      console.warn(`[LDAP-AUTH] Login failed for ${username}: ${err.message}`);
    }

    return res.status(401).json({ status: "error", error: "Invalid username or password." });
  });

  app.post("/api/auth/logout", (req, res) => {
    clearAppSessionCookie(req, res);
    res.json({ status: "success" });
  });

  app.get("/api/local-users", (_req, res) => {
    res.json({ status: "success", users: readLocalUsers().map(publicUser), credentialsFile: LOCAL_USERS_PATH });
  });

  app.post("/api/local-users", (req, res) => {
    refreshRuntimeConfig();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "").trim() || randomBytes(12).toString("hex");
    const fullName = String(req.body?.fullName || username).trim();
    const emailDomain = runtimeConfig.app.localUserEmailDomain;
    const email = String(req.body?.email || (emailDomain ? `${username}@${emailDomain}` : "")).trim();
    const role = (["super_admin", "observer"].includes(req.body?.role) ? req.body.role : "observer") as LocalUserRecord["role"];
    const department = String(req.body?.department || "Azure DevOps").trim();

    if (!username || !fullName || !email) {
      return res.status(400).json({ status: "error", error: "Username, full name, and email are required." });
    }

    const users = readLocalUsers();
    if (users.some((user) => user.username.toLowerCase() === username)) {
      return res.status(409).json({ status: "error", error: "A local user with this username already exists." });
    }

    const newUser: LocalUserRecord = {
      id: `u_${Date.now()}`,
      username,
      password,
      fullName,
      email,
      role,
      type: "local",
      createdOn: new Date().toISOString().slice(0, 10),
      department,
    };
    users.unshift(newUser);
    saveLocalUsers(users);
    res.json({ status: "success", user: publicUser(newUser), credentialsFile: LOCAL_USERS_PATH });
  });

  app.patch("/api/local-users/:id/password", (req, res) => {
    const password = String(req.body?.password || "").trim();
    if (!password) {
      return res.status(400).json({ status: "error", error: "Password is required." });
    }

    const users = readLocalUsers();
    const target = users.find((user) => user.id === req.params.id);
    if (!target) {
      return res.status(404).json({ status: "error", error: "Local user not found." });
    }

    target.password = password;
    saveLocalUsers(users);
    res.json({ status: "success", user: publicUser(target), credentialsFile: LOCAL_USERS_PATH });
  });

  app.delete("/api/local-users/:id", (req, res) => {
    const users = readLocalUsers();
    const target = users.find((user) => user.id === req.params.id);
    if (!target) {
      return res.status(404).json({ status: "error", error: "Local user not found." });
    }
    if (target.role === "super_admin") {
      return res.status(400).json({ status: "error", error: "Cannot delete a super admin account." });
    }
    saveLocalUsers(users.filter((user) => user.id !== req.params.id));
    res.json({ status: "success" });
  });

  // --- ES LOGS ENDPOINT ---
  app.get("/api/es-health", async (req, res) => {
    try {
      const targetUrls = (req.query.nodes as string)?.split(',').map(s => s.trim()).filter(Boolean) || [ES_URL];
      let okCount = 0;
      let lastStatus = "red";
      let error = null;

      // Ping to the first available or try all
      for (const url of targetUrls) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);

          const healthObj = await esFetch(`${url}/_cluster/health`, {
            headers: esHeaders(),
            signal: controller.signal as any
          }).then(r => r.json());
          clearTimeout(timeoutId);

          if (healthObj && (healthObj.status === "green" || healthObj.status === "yellow")) {
            okCount++;
            lastStatus = healthObj.status;
          }
        } catch (e: any) {
          error = e.message;
        }
      }

      if (okCount > 0) {
        res.json({ ok: true, status: lastStatus });
      } else {
        res.status(500).json({ ok: false, error: error || "Cluster unreachable or red" });
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- LDAP PORT PING HEALTH CHECK ---
  app.get("/api/ldap-health", async (req, res) => {
    const serverUrl = req.query.url as string;
    if (!serverUrl) {
      return res.status(400).json({ ok: false, error: "Query parameter 'url' is required." });
    }

    try {
      let hostname = "";
      let port = 389; // standard default ldap port

      if (serverUrl.includes("://")) {
        try {
          const parsed = new URL(serverUrl);
          hostname = parsed.hostname;
          if (parsed.port) {
            port = parseInt(parsed.port, 10);
          } else if (parsed.protocol === "ldaps:") {
            port = 636;
          }
        } catch (e) {
          const match = serverUrl.match(/(?:ldaps?:\/\/)?([^:/]+)(?::(\d+))?/);
          if (match) {
            hostname = match[1];
            if (match[2]) port = parseInt(match[2], 10);
          }
        }
      } else {
        const match = serverUrl.match(/^([^:/]+)(?::(\d+))?/);
        if (match) {
          hostname = match[1];
          if (match[2]) {
            port = parseInt(match[2], 10);
          }
        }
      }

      if (!hostname) {
        return res.json({ ok: false, error: "Failed to parse hostname from server URL." });
      }

      const isConnected = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2500);

        socket.on("connect", () => {
          socket.destroy();
          resolve(true);
        });

        socket.on("error", () => {
          socket.destroy();
          resolve(false);
        });

        socket.on("timeout", () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(port, hostname);
      });

      if (isConnected) {
        res.json({ ok: true });
      } else {
        res.json({ ok: false, error: `Connection refused or timeout connecting to ${hostname}:${port}. Ensure the LDAP directory is running and accessible on that port.` });
      }
    } catch (err: any) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get("/api/es-indices", async (req, res) => {
    try {
      const matchPattern = req.query.pattern || '*';
      const esRes = await esFetch(`${ES_URL}/_cat/indices/${matchPattern}?format=json`, {
        headers: esHeaders()
      }).then(r => r.json()).catch(() => null);

      res.json({ indices: Array.isArray(esRes) ? esRes : [] });
    } catch (e: any) {
      console.error(`[ES-PROXY] Failed to fetch indices from ES: ${e.message}`);
      res.status(502).json({ indices: [], error: e.message });
    }
  });

  app.get("/api/logs", async (req, res) => {
    try {
      const indexParam = (req.query.index as string) || "*";
      const queryText = String(req.query.q || "").trim();
      const fromTime = String(req.query.from || "").trim();
      const toTime = String(req.query.to || "").trim();
      console.log(`[ES-QUERY] Searching documents for index pattern: [${indexParam}] query=[${queryText || "*"}]...`);

      const catalogIndex = getS3CatalogIndex();
      const isCatalogIndex = Boolean(catalogIndex) && indexParam === catalogIndex;

      const filters: any[] = [];
      if (fromTime || toTime) {
        const range: Record<string, string> = {};
        if (fromTime) range.gte = fromTime;
        if (toTime) range.lte = toTime;
        filters.push({ range: { timestamp: range } });
      }

      const must: any[] = [];
      if (queryText && queryText !== "*") {
        const parsedQuery = parseSearchQuery(queryText);
        parsedQuery.filters.forEach(({ field, value }) => {
          must.push(buildFieldValueQuery(field, value));
        });
        parsedQuery.terms.forEach((term) => {
          must.push(buildGlobalValueQuery(term));
        });
      }

      const searchBody = {
        size: 1000,
        sort: [{ timestamp: { order: "desc", unmapped_type: "date" } }],
        query: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter: filters,
          },
        },
      };

      const queryEs = async () =>
        esFetch(`${ES_URL}/${encodeURIComponent(indexParam)}/_search`, {
          method: "POST",
          headers: esHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(searchBody),
        }).then((r) => r.json()).catch(() => null);

      let esRes = await queryEs();

      if (
        isCatalogIndex &&
        esRes?.hits?.hits &&
        esRes.hits.hits.length === 0
      ) {
        console.log(`[ES-QUERY] Catalog index empty — running S3 catalog sync...`);
        await syncS3CatalogToElasticsearch(true);
        esRes = await queryEs();
      }

      if (esRes && esRes.hits && esRes.hits.hits && esRes.hits.hits.length > 0) {
        const logs = esRes.hits.hits.map((h: any) => ({
          ...h._source,
          _id: h._source?._id ?? h._source?.id ?? h._id,
          _index: h._index ?? h._source?._index ?? h._source?.index ?? indexParam,
        }));
        console.log(`[ES-QUERY] Retrieved ${logs.length} documents from Elasticsearch for index [${indexParam}].`);
        res.json({ logs });
      } else if (esRes && esRes.hits && esRes.hits.hits) {
        console.log(`[ES-QUERY] Legitimate empty index [${indexParam}] detected in Elasticsearch.`);
        res.json({ logs: [] });
      } else {
        res.status(500).json({ error: "Elasticsearch is unreachable or error occurred" });
      }
    } catch (e: any) {
      console.error(`[ES-PROXY] Failed to fetch logs from ES: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/logs", async (req, res) => {
    try {
      const { index } = req.body;
      if (!index) {
        return res.status(400).json({ status: "error", error: "Missing Target Index name" });
      }

      const cleanIndex = normalizeWritableIndexName(index);
      console.log(`[ES-WRITE] Seeding documents for given index: [${cleanIndex}]...`);

      const seedLogs = generateMockLogs(new Date().toISOString(), cleanIndex);

      let bulkBody = "";
      seedLogs.forEach(log => {
        bulkBody += JSON.stringify({ index: { _index: cleanIndex, _id: log._id } }) + "\n";
        bulkBody += JSON.stringify(stripElasticsearchMetadata(log as unknown as Record<string, unknown>)) + "\n";
      });

      let bulkResponse = null;
      let esSuccess = false;

      try {
        bulkResponse = await esFetch(`${ES_URL}/_bulk?refresh=true`, {
          method: "POST",
          headers: esHeaders({ "Content-Type": "application/x-ndjson" }),
          body: bulkBody
        });

        if (bulkResponse.ok) {
          const resultObj = await bulkResponse.json();
          if (resultObj && resultObj.errors) {
             console.error(`[ES-WRITE-ERR] Bulk seeding failed with errors for index [${cleanIndex}]`);
             const itemErrors = resultObj.items?.filter((it: any) => it.index && it.index.error);
             return res.status(500).json({ status: "error", error: "Seeding completed with Elasticsearch errors", details: itemErrors?.slice(0, 3) });
          } else {
             esSuccess = true;
          }
        }
      } catch (err: any) {
        console.log(`[ES-WRITE-SIMULATION] Native Elasticsearch unreachable. Seeding index [${cleanIndex}] using memory proxy...`);
      }

      // Always save to fallback simulated memory storage
      globalSessionLogs = [...seedLogs, ...globalSessionLogs.filter((log: any) => log._index !== cleanIndex)];

      return res.json({
        status: "success",
        count: seedLogs.length,
        index: cleanIndex,
        source: esSuccess ? "elasticsearch" : "sandbox-simulation"
      });
    } catch (err: any) {
      console.error(`[ES-WRITE-ERR] Exception in POST /api/logs:`, err.message);
      return res.status(500).json({ status: "error", error: err.message });
    }
  });

  // --- S3 PROXY ENDPOINTS ---

  // 1. Get current configuration
  app.get("/api/s3/config", (req, res) => {
    refreshRuntimeConfig();
    res.json({ status: "success", config: runtimeConfig.s3 });
  });

  async function testS3Health(config: AppConfig["s3"], res: express.Response) {
    try {
      const s3 = getS3Client(config);
      await s3.send(new ListObjectsV2Command({ Bucket: config.bucketName, MaxKeys: 1 }));
      res.json({ ok: true });
    } catch (err: any) {
      res.json({ ok: false, error: err.message });
    }
  }

  // Test S3 Connection
  app.get("/api/s3/health", async (_req, res) => {
    await testS3Health(globalS3Config, res);
  });

  app.post("/api/s3/health", async (req, res) => {
    const current = loadConfig();
    const secretAccessKey = req.body?.secretAccessKey === SECRET_MASK ? current.s3.secretAccessKey : req.body?.secretAccessKey;
    const config = normalizeS3Config({
      ...current.s3,
      ...req.body,
      secretAccessKey: secretAccessKey || current.s3.secretAccessKey,
    });
    await testS3Health(config, res);
  });

  app.get("/api/es/config", (req, res) => {
    refreshRuntimeConfig();
    res.json({ status: "success", config: runtimeConfig.elasticsearch });
  });

  app.post("/api/es/config", (req, res) => {
    const current = loadConfig();
    const next = saveConfig({
      ...current,
      elasticsearch: {
        ...current.elasticsearch,
        ...req.body,
      },
    });
    refreshRuntimeConfig();
    console.log(`[ES-CONFIG] Updated Elasticsearch endpoint to ${getPrimaryEsUrl(next.elasticsearch)}`);
    res.json({ status: "success", config: next.elasticsearch });
  });

  app.get("/api/ldap/config", (req, res) => {
    refreshRuntimeConfig();
    res.json({ status: "success", config: runtimeConfig.ldap });
  });

  app.post("/api/ldap/test", async (req, res) => {
    const current = loadConfig();
    const ldapConfig = normalizeLdapConfig({
      ...current.ldap,
      ...(req.body?.config || req.body || {}),
    });
    const testUsername = String(req.body?.testUsername || "").trim();
    const testPassword = String(req.body?.testPassword || "");

    try {
      if (getLdapManagerDn(ldapConfig)) {
        await ldapBind(ldapConfig, getLdapManagerDn(ldapConfig), getLdapManagerPassword(ldapConfig));
      } else if (!testUsername) {
        const bases = getLdapSearchBases(ldapConfig);
        if (bases.length === 0) throw new Error("LDAP URL or Search Base is required.");
        await ldapSearch(ldapConfig, bases[0], "(objectClass=*)", ["dn"]);
      }

      let user: AuthenticatedUserRecord | null = null;
      if (testUsername || testPassword) {
        if (!testUsername || !testPassword) {
          throw new Error("Both Test User Name and Test Password are required for user authentication testing.");
        }
        user = await authenticateLdapUserWithConfig(ldapConfig, testUsername, testPassword);
      }

      res.json({
        ok: true,
        status: user ? "User authentication successful." : "Manager connection successful.",
        user,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message || "LDAP test failed." });
    }
  });

  app.post("/api/ldap/config", (req, res) => {
    const current = loadConfig();
    const next = saveConfig({
      ...current,
      ldap: normalizeLdapConfig({
        ...current.ldap,
        ...req.body,
      }),
    });
    refreshRuntimeConfig();
    console.log(`[LDAP-CONFIG] Updated LDAP endpoint to ${getLdapUrl(next.ldap)}`);
    res.json({ status: "success", config: next.ldap });
  });

  app.get("/api/app/config", (_req, res) => {
    refreshRuntimeConfig();
    res.json({ status: "success", config: runtimeConfig.app });
  });

  app.get("/api/app/session", (_req, res) => {
    refreshRuntimeConfig();
    res.json({
      status: "success",
      bootId: APP_BOOT_ID,
      sessionTimeoutMinutes: runtimeConfig.app.sessionTimeoutMinutes,
    });
  });

  app.post("/api/app/config", (req, res) => {
    try {
      const current = loadConfig();
      const regenerate = req.body?.regenerateCertificate === true;
      let appConfig = normalizeAppConfig({
        ...current.app,
        ...req.body,
        httpsPort: req.body?.httpsPort ?? current.app.httpsPort,
        validDays: req.body?.validDays ?? current.app.validDays,
      });
      delete (appConfig as any).regenerateCertificate;

      if (appConfig.enableHTTPS && (regenerate || !appConfig.certificateContent || !appConfig.privateKeyContent)) {
        const generated = createSelfSignedCertificate(appConfig.commonName, appConfig.validDays);
        appConfig = {
          ...appConfig,
          certificateContent: generated.certificateContent,
          privateKeyContent: generated.privateKeyContent,
        };
      }

      const next = saveConfig({ ...current, app: appConfig });
      refreshRuntimeConfig();
      res.json({ status: "success", config: next.app, restartRequired: true });
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        error: `Failed to write app config to config.yaml: ${err.message}`,
      });
    }
  });

  // 2. Save current configuration
  app.post("/api/s3/config", (req, res) => {
    const current = loadConfig();
    const {
      endpointUrl,
      accessKeyId,
      secretAccessKey,
      bucketName,
      region,
      enableSSL,
      verifyCertificates,
      caCertificateName,
      caCertificateContent,
      forcePathStyle,
      catalogIndex,
      proxyAuthEnabled,
      proxyAuthMethod,
      proxyBasicUsername,
    } = req.body;

    // Protect secret payload if unedited
    const newSecret = secretAccessKey === SECRET_MASK ? globalS3Config.secretAccessKey : secretAccessKey;

    globalS3Config = normalizeS3Config({
      endpointUrl: endpointUrl || globalS3Config.endpointUrl,
      accessKeyId: accessKeyId || globalS3Config.accessKeyId,
      secretAccessKey: newSecret || globalS3Config.secretAccessKey,
      bucketName: bucketName || globalS3Config.bucketName,
      region: region || globalS3Config.region,
      enableSSL: enableSSL !== undefined ? enableSSL : globalS3Config.enableSSL,
      verifyCertificates: verifyCertificates !== undefined ? verifyCertificates : globalS3Config.verifyCertificates,
      caCertificateName: caCertificateName || globalS3Config.caCertificateName,
      caCertificateContent: caCertificateContent || globalS3Config.caCertificateContent,
      forcePathStyle: forcePathStyle !== undefined ? forcePathStyle : globalS3Config.forcePathStyle,
      catalogIndex: catalogIndex !== undefined ? String(catalogIndex).trim() : globalS3Config.catalogIndex,
      proxyAuthEnabled: proxyAuthEnabled !== undefined ? proxyAuthEnabled : (globalS3Config as any).proxyAuthEnabled,
      proxyAuthMethod: proxyAuthMethod === "apiKey" ? "apiKey" : "basic",
      proxyBasicUsername: proxyBasicUsername !== undefined ? String(proxyBasicUsername).trim() : (globalS3Config as any).proxyBasicUsername,
      proxyApiKeys: sanitizeProxyApiKeys((globalS3Config as any).proxyApiKeys),
    });
    validateS3Config(globalS3Config);

    const next = saveConfig({ ...current, s3: globalS3Config });
    refreshRuntimeConfig();
    console.log(`[S3-CONFIG] Updated S3/MinIO parameters: endpoint=${next.s3.endpointUrl}, bucket=${next.s3.bucketName}`);
    res.json({ status: "success", message: "S3 Configuration updated successfully.", config: next.s3 });
  });

  app.post("/api/s3/proxy-api-keys", (req, res) => {
    const current = loadConfig();
    const name = String(req.body?.name || "S3 Proxy API Key").trim();
    const rawKey = `rls3_${randomBytes(24).toString("hex")}`;
    const apiKey = {
      id: `s3key_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name,
      keyHash: hashProxyApiKey(rawKey),
      createdOn: new Date().toISOString(),
      revokedOn: "",
    };
    const nextS3 = normalizeS3Config({
      ...current.s3,
      proxyApiKeys: [...sanitizeProxyApiKeys((current.s3 as any).proxyApiKeys), apiKey],
    });
    const next = saveConfig({ ...current, s3: nextS3 });
    refreshRuntimeConfig();
    globalS3Config = runtimeConfig.s3;
    res.json({ status: "success", apiKey: rawKey, keyRecord: apiKey, config: next.s3 });
  });

  app.delete("/api/s3/proxy-api-keys/:id", (req, res) => {
    const current = loadConfig();
    const id = String(req.params.id || "");
    const keys = sanitizeProxyApiKeys((current.s3 as any).proxyApiKeys);
    const nextS3 = normalizeS3Config({
      ...current.s3,
      proxyApiKeys: keys.filter((key) => key.id !== id),
    });
    const next = saveConfig({ ...current, s3: nextS3 });
    refreshRuntimeConfig();
    globalS3Config = runtimeConfig.s3;
    res.json({ status: "success", config: next.s3 });
  });

  // --- DISCOVER UI CONFIG (default index for viewers) ---
  app.get("/api/discover/config", (req, res) => {
    refreshRuntimeConfig();
    res.json({
      status: "success",
      config: {
        ...runtimeConfig.discover,
        s3CatalogIndex: getS3CatalogIndex(),
      },
    });
  });

  app.post("/api/discover/config", (req, res) => {
    const current = loadConfig();
    const { defaultIndex, linkRules, username } = req.body;
    const nextDiscover = { ...current.discover };

    if (typeof defaultIndex === "string") {
      nextDiscover.defaultIndex = defaultIndex.trim();
    }

    if (Array.isArray(linkRules)) {
      nextDiscover.linkRules = linkRules
        .filter((rule) => rule && typeof rule === "object")
        .map((rule) => ({
          columnName: String(rule.columnName || "").trim(),
          urlTemplate: String(rule.urlTemplate || "{value}"),
          labelTemplate: String(rule.labelTemplate || "{value}"),
          openInNewTab: Boolean(rule.openInNewTab),
          colorScheme: ["default", "blue", "emerald", "amber", "indigo", "rose"].includes(rule.colorScheme)
            ? rule.colorScheme
            : "blue",
        }))
        .filter((rule) => rule.columnName);
    }

    const next = saveConfig({ ...current, discover: nextDiscover });
    refreshRuntimeConfig();
    console.log(`[DISCOVER-CONFIG] Updated Discover config by ${username || "admin"}.`);
    res.json({ status: "success", config: next.discover });
  });

  // --- OBSERVE-AUDIT LOG ENDPOINTS ---

  // 1. Get current Audit Settings
  app.get("/api/audit/config", (req, res) => {
    refreshRuntimeConfig();
    res.json({ status: "success", config: runtimeConfig.audit });
  });

  // 2. Update active Elasticsearch Audit Index target
  app.post("/api/audit/config", (req, res) => {
    const current = loadConfig();
    const { elasticsearchIndex, username } = req.body;
    let next = current;
    if (elasticsearchIndex) {
      const oldIndex = current.audit.elasticsearchIndex;
      next = saveConfig({
        ...current,
        audit: { ...current.audit, elasticsearchIndex },
      });
      refreshRuntimeConfig();

      // Document the configuration migration event itself
      const auditLog: AuditLogEntry = {
        id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        action: "CONFIG_CHANGE",
        username: username || "admin",
        details: `Migrated security audit logs active index mapping from [${oldIndex}] to [${elasticsearchIndex}]`,
        index: elasticsearchIndex,
        ip: req.ip || "127.0.0.1"
      };

      auditLogsDb.unshift(auditLog);
      indexAuditLogToElasticsearch(auditLog);

      console.log(`[AUDIT-INDEX] Security audit indexing target shifted to: ${elasticsearchIndex}`);
    }
    res.json({ status: "success", config: next.audit });
  });

  // 3. List Audit Log Database entries filtered for the active or given index
  app.get("/api/audit/logs", async (req, res) => {
    const targetIndex = (req.query.index as string) || globalAuditConfig.elasticsearchIndex;
    if (!targetIndex) {
      return res.status(400).json({
        status: "error",
        error: "Audit Elasticsearch index is not configured in config.yaml.",
      });
    }
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize || "25"), 10) || 25));
    const from = (page - 1) * pageSize;
    try {
      console.log(`[ES-AUDIT-READ] Attempting to query Elasticsearch index: [${targetIndex}] page=${page} pageSize=${pageSize}...`);
      const response = await esFetch(`${ES_URL}/${targetIndex}/_search`, {
        method: "POST",
        headers: esHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          from,
          size: pageSize,
          sort: [{ timestamp: { order: "desc", unmapped_type: "date" } }],
          query: { match_all: {} },
          track_total_hits: true,
        }),
      });

      if (response.ok) {
        const esRes = await response.json();
        if (esRes && esRes.hits && esRes.hits.hits) {
          const logs = esRes.hits.hits.map((h: any) => h._source);
          const total = typeof esRes.hits.total === "number" ? esRes.hits.total : Number(esRes.hits.total?.value ?? logs.length);
          console.log(`[ES-AUDIT-READ] Success! Retrieved ${logs.length}/${total} trace items from ES index [${targetIndex}]`);
          return res.json({ status: "success", logs, total, page, pageSize, activeIndex: targetIndex, source: "elasticsearch" });
        }
      } else {
        console.warn(`[ES-AUDIT-READ-WARN] Elasticsearch returned code ${response.status}. Falling back to sandbox file storage / memory log.`);
      }
    } catch (err: any) {
      console.error(`[ES-AUDIT-READ-ERR] Connection to ES failed:`, err.message);
    }

    const filteredLogs = auditLogsDb
      .filter(log => log.index === targetIndex)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    res.json({
      status: "success",
      logs: filteredLogs.slice(from, from + pageSize),
      total: filteredLogs.length,
      page,
      pageSize,
      activeIndex: targetIndex,
      source: "memory-fallback",
    });
  });

  // 4. API Registry helper to trace successful Authentications from user logins
  app.post("/api/audit/register-login", (req, res) => {
    const { username, fullName, department, authType } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username is required to map session logins." });
    }

    const newLog: AuditLogEntry = {
      id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      action: "LOGIN",
      username,
      details: `User Authenticated: ${fullName || username} successfully initialized a secure ${authType || "Local"} session (Department: ${department || "Unassigned"}).`,
      index: globalAuditConfig.elasticsearchIndex,
      ip: req.ip || "127.0.0.1"
    };

    auditLogsDb.unshift(newLog);
    indexAuditLogToElasticsearch(newLog);

    console.log(`[AUDIT-LOG] Login audit registered: ${username} has signed in.`);
    res.json({ status: "success", entry: newLog });
  });

  // Bulk download: zip multiple S3 objects from MinIO
  app.post("/api/s3/bulk-download", async (req, res) => {
    if (!validateS3ProxyDownloadAuth(req, res)) return;

    const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const username = getDownloadAuditUsername(req, req.body?.username);

    if (keys.length === 0) {
      return res.status(400).json({ error: "At least one S3 object key is required." });
    }

    const uniqueKeys = [...new Set(keys.filter((k) => typeof k === "string" && k.trim()))];
    console.log(`[S3-BULK] Packaging ${uniqueKeys.length} archive(s) for user [${username}]`);

    for (const key of uniqueKeys) {
      const downloadLog: AuditLogEntry = {
        id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        action: "DOWNLOAD",
        username,
        details: `Bulk download included S3 archive key: [${key}]`,
        index: globalAuditConfig.elasticsearchIndex,
        ip: req.ip || "127.0.0.1",
      };
      auditLogsDb.unshift(downloadLog);
      indexAuditLogToElasticsearch(downloadLog);
    }

    try {
      const zip = new JSZip();
      for (const key of uniqueKeys) {
        const buffer = await fetchS3ObjectBuffer(key);
        const fileName = path.basename(key);
        zip.file(fileName, buffer);
      }

      const timestampStr = new Date().toISOString().slice(0, 10);
      const fileName = `s3_archives_${timestampStr}.zip`;
      const tempPath = getTempDownloadPath(fileName);
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      await fs.promises.writeFile(tempPath, zipBuffer);
      sendTempDownload(res, tempPath, fileName, "application/zip");
    } catch (error: any) {
      console.error(`[S3-BULK-ERR] ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  // 3. SECURE PROXY DOWNLOAD
  // Fetches binary files from S3/MinIO server-side and streams them to the user
  app.get("/api/s3/proxy-download", async (req, res) => {
    if (!validateS3ProxyDownloadAuth(req, res)) return;

    const key = req.query.key as string;
    const username = getDownloadAuditUsername(req, req.query.username);

    if (!key) {
      return res.status(400).json({ error: "Query parameter 'key' is required." });
    }

    console.log(`[S3-PROXY] Intercepted proxy download request for key: [${key}] by user [${username}]`);

    // Log the file download action immediately to the active Elasticsearch auditing index
    const downloadLog: AuditLogEntry = {
      id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      action: "DOWNLOAD",
      username: username,
      details: `Successfully proxied secure download of cloud snapshot archive index key: [${key}]`,
      index: globalAuditConfig.elasticsearchIndex,
      ip: req.ip || "127.0.0.1"
    };

    auditLogsDb.unshift(downloadLog);
    indexAuditLogToElasticsearch(downloadLog);

    try {
      const s3 = getS3Client();
      const command = new GetObjectCommand({
        Bucket: globalS3Config.bucketName,
        Key: key
      });

      // Attempt actual S3 fetch
      const result = await s3.send(command);

      if (result && result.Body) {
        const fileName = path.basename(key);
        const tempPath = getTempDownloadPath(fileName);
        try {
          await pipeline(result.Body as NodeJS.ReadableStream, fs.createWriteStream(tempPath));
          sendTempDownload(res, tempPath, fileName, result.ContentType || "application/octet-stream");
        } catch (err) {
          cleanupTempFile(tempPath);
          throw err;
        }
      } else {
        res.status(404).send("File not found in S3");
      }
    } catch (error: any) {
      console.error(`[S3-ERR] Severe error in S3 proxy download handler: ${error.message}`);
      res.status(500).json({ error: `Connection failed: ${error.message}` });
    }
  });

  // 4. LIST FILES (search / prefix / type filters)
  app.get("/api/s3/list", async (req, res) => {
    try {
      const search = ((req.query.search as string) || "").trim().toLowerCase();
      const prefix = ((req.query.prefix as string) || "").trim();
      const typeFilter = ((req.query.type as string) || "all").trim().toLowerCase();

      const { files: rawFiles, source } = await listAllS3Files();

      let files = rawFiles.map((f) => ({
        ...f,
        description: s3FileMetadata[f.key]?.description ?? "",
        download_url: `/api/s3/proxy-download?key=${encodeURIComponent(f.key)}`,
      }));

      if (prefix) {
        files = files.filter((f) => f.key.startsWith(prefix));
      }
      if (search) {
        files = files.filter(
          (f) =>
            f.key.toLowerCase().includes(search) ||
            (f.description && f.description.toLowerCase().includes(search))
        );
      }
      if (typeFilter === "zip") {
        files = files.filter((f) => f.key.endsWith(".zip"));
      } else if (typeFilter === "pdf") {
        files = files.filter((f) => f.key.endsWith(".pdf"));
      } else if (typeFilter === "json") {
        files = files.filter((f) => f.key.endsWith(".json"));
      }

      files.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

      return res.json({ status: "success", source, total: files.length, files });
    } catch (err: any) {
      res.status(500).json({ error: err.message, files: MOCK_FILES_DB });
    }
  });

  // Delete S3 object
  app.delete("/api/s3/object", async (req, res) => {
    const key = (req.query.key as string) || req.body?.key;
    if (!key) {
      return res.status(400).json({ error: "Query/body parameter 'key' is required." });
    }

    try {
      const s3 = getS3Client();
      await s3
        .send(new DeleteObjectCommand({ Bucket: globalS3Config.bucketName, Key: key }))
        .catch(() => null);

      const safeKey = key.replace(/\//g, "_");
      const filePath = path.join(SANDBOX_STORAGE_DIR, safeKey);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      delete s3FileMetadata[key];
      await deleteCatalogDocForKey(key);

      res.json({ status: "success", message: `Deleted object [${key}]` });
    } catch (err: any) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  // Update object metadata (description) + re-index catalog doc
  app.put("/api/s3/object", async (req, res) => {
    const { key, description } = req.body;
    if (!key) {
      return res.status(400).json({ error: "Field 'key' is required." });
    }

    s3FileMetadata[key] = { ...s3FileMetadata[key], description };

    const { files } = await listAllS3Files();
    const file = files.find((f) => f.key === key);
    const catalogIndex = getS3CatalogIndex();
    if (file && catalogIndex) {
      const log = buildCatalogLogFromS3File(file, catalogIndex, description);
      await bulkIndexToElasticsearch([
        { _index: catalogIndex, _id: log._id, body: { ...log } },
      ]);
    }

    res.json({ status: "success", key, description });
  });

  // 5. UPLOAD TO S3 Gateway proxy
  app.post("/api/s3/upload", async (req, res) => {
    const { fileContent, contentType } = req.body;
    const key = normalizeS3ObjectKey(String(req.body?.key || ""));
    if (!key || !fileContent) {
      return res.status(400).json({ error: "Both 'key' and 'fileContent' (base64 or text) are required." });
    }

    const binaryBuffer = Buffer.from(fileContent.includes("base64,") ? fileContent.split(",")[1] : fileContent, "base64");

    console.log(`[S3-UPLOAD] Received upload request for key: [${key}] (${binaryBuffer.length} bytes)`);

    try {
      // 1. Try real S3 first
      const s3 = getS3Client();
      const command = new PutObjectCommand({
        Bucket: globalS3Config.bucketName,
        Key: key,
        Body: binaryBuffer,
        ContentType: contentType || "application/octet-stream"
      });

      let realS3Success = false;
      await s3.send(command).then(() => {
        realS3Success = true;
        console.log(`[S3-SUCCESS] Uploaded block directly to MinIO: key=[${key}]`);
      }).catch((err) => {
        console.warn(`[S3-WARN] Real cluster storage upload failed or unconfigured. Writing to local Sandbox Disk instead.`);
      });

      // 2. Write to local Sandbox Physical folder so it persists for listing and downloading in UI
      const safeKey = key.replace(/\//g, "_");
      const filePath = path.join(SANDBOX_STORAGE_DIR, safeKey);

      // Ensure sub-directories are ready
      const dirOfFile = path.dirname(filePath);
      if (!fs.existsSync(dirOfFile)) {
        fs.mkdirSync(dirOfFile, { recursive: true });
      }

      fs.writeFileSync(filePath, binaryBuffer);
      console.log(`[S3-MOCK-WRITE] Written directly to persistent Sandbox Storage disk: ${filePath}`);

      if (req.body.description) {
        s3FileMetadata[key] = { description: req.body.description };
      }

      const listed: S3ListedFile = {
        key,
        size: binaryBuffer.length,
        lastModified: new Date().toISOString(),
        contentType: contentType || inferContentType(key),
      };
      const catalogIndex = getS3CatalogIndex();
      if (catalogIndex) {
        const catalogLog = buildCatalogLogFromS3File(listed, catalogIndex, s3FileMetadata[key]?.description);
        await bulkIndexToElasticsearch([
          { _index: catalogIndex, _id: catalogLog._id, body: { ...catalogLog } },
        ]);
      }

      // Register the upload action to Elasticsearch audit logs
      const uploadLog: AuditLogEntry = {
        id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        action: "UPLOAD",
        username: "admin",
        details: `Successfully uploaded and verified security partition package file key: [${key}] (${binaryBuffer.length} bytes)`,
        index: globalAuditConfig.elasticsearchIndex,
        ip: req.ip || "127.0.0.1"
      };
      auditLogsDb.unshift(uploadLog);
      indexAuditLogToElasticsearch(uploadLog);

      res.json({
        status: "success",
        message: realS3Success ? "File uploaded directly to S3 / Minio!" : "File saved to Sandbox simulated physical storage successfully.",
        key,
        size: binaryBuffer.length,
        source: realS3Success ? "real-s3" : "sandbox-simulation-storage"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- VITE DEV & CLIENT MIDDLEWARE ROUTING ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Full-stack Dev running on port ${PORT}`);
    console.log(`[SERVER] S3 Secure proxy listening at http://localhost:${PORT}/api/s3/proxy-download`);
  });

  refreshRuntimeConfig();
  if (runtimeConfig.app.enableHTTPS) {
    try {
      https
        .createServer(
          {
            cert: runtimeConfig.app.certificateContent,
            key: runtimeConfig.app.privateKeyContent,
          },
          app
        )
        .listen(runtimeConfig.app.httpsPort, "0.0.0.0", () => {
          console.log(`[SERVER] HTTPS enabled at https://localhost:${runtimeConfig.app.httpsPort}`);
        });
    } catch (err: any) {
      console.error(`[SERVER] Failed to start HTTPS listener: ${err.message}`);
    }
  }
}

startServer();
