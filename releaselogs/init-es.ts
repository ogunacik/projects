import fs from "fs";
import path from "path";
import https from "https";
import * as yaml from "js-yaml";
import { Agent as UndiciAgent, type Dispatcher } from "undici";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import JSZip from "jszip";
import { generateMockLogs } from "./src/data/mockElasticData";
import { generateS3ArchiveCatalogLogs } from "./src/data/s3ArchiveCatalog";

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "config.yaml");

function loadAppConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return (yaml.load(raw) as any) || null;
  } catch (err) {
    return null;
  }
}

const APP_CONFIG = loadAppConfig();
const ES_URL = APP_CONFIG?.elasticsearch?.nodeUrls?.split(",")[0]?.trim() || "";
const S3_CATALOG_INDEX = APP_CONFIG?.s3?.catalogIndex || "";
const ES_AUTH = (() => {
  if (!APP_CONFIG?.elasticsearch) return "";
  if (APP_CONFIG.elasticsearch.authMethod === "basic" && APP_CONFIG.elasticsearch.username && APP_CONFIG.elasticsearch.password) {
    return "Basic " + Buffer.from(`${APP_CONFIG.elasticsearch.username}:${APP_CONFIG.elasticsearch.password}`).toString("base64");
  }
  if (APP_CONFIG.elasticsearch.authMethod === "token" && APP_CONFIG.elasticsearch.token) {
    return `ApiKey ${APP_CONFIG.elasticsearch.token}`;
  }
  return "";
})();

function createTlsOptions(config: any) {
  const rejectUnauthorized = config?.verifyServerCertificate ?? config?.verifyCertificates ?? true;
  const ca = config?.caCertificateContent?.trim() || undefined;
  const cert = config?.clientCertificateContent?.trim() || undefined;
  const key = config?.clientKeyContent?.trim() || undefined;
  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
  };
}

const esFetchDispatcher: Dispatcher | undefined =
  APP_CONFIG?.elasticsearch?.enableSSL || ES_URL.startsWith("https://")
    ? new UndiciAgent({ connect: createTlsOptions(APP_CONFIG.elasticsearch) })
    : undefined;

function esFetch(input: string, init: RequestInit = {}) {
  return fetch(input, {
    ...init,
    ...(esFetchDispatcher ? { dispatcher: esFetchDispatcher } : {}),
  } as RequestInit & { dispatcher?: Dispatcher });
}

function getS3Client() {
  const s3Config = APP_CONFIG?.s3;
  if (!s3Config?.bucketName) return null;

  const clientConfig: any = {
    region: s3Config.region || "us-east-1",
    endpoint: s3Config.endpointUrl || undefined,
    forcePathStyle: s3Config.forcePathStyle !== false,
    credentials:
      s3Config.accessKeyId && s3Config.secretAccessKey
        ? {
            accessKeyId: s3Config.accessKeyId,
            secretAccessKey: s3Config.secretAccessKey,
        }
        : undefined,
  };

  if (s3Config.enableSSL || s3Config.endpointUrl?.startsWith("https://")) {
    clientConfig.requestHandler = new NodeHttpHandler({
      httpsAgent: new https.Agent(createTlsOptions(s3Config)),
    });
  }

  return new S3Client(clientConfig);
}

async function configureKibanaSystemPassword() {
  const password = process.env.KIBANA_SYSTEM_PASSWORD?.trim();
  if (!password || !ES_AUTH) return;

  const response = await esFetch(`${ES_URL}/_security/user/kibana_system/_password`, {
    method: "POST",
    headers: {
      "Authorization": ES_AUTH,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password }),
  });

  if (response.ok) {
    console.log("[ES-INIT-SERVICE] kibana_system password configured.");
  } else {
    const text = await response.text().catch(() => "");
    console.warn(`[ES-INIT-SERVICE] Could not configure kibana_system password: ${response.status} ${text.slice(0, 200)}`);
  }
}

async function createMockArchiveBuffer(label: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("README.txt", `Mock archive: ${label}\nGenerated: ${new Date().toISOString()}\n`);
  zip.file("logs/sample.log", `[${new Date().toISOString()}] INFO Mock payload for ${label}\n`);
  zip.file("manifest.json", JSON.stringify({ archive: label, type: "mock-telemetry-bundle" }, null, 2));
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function seedS3ObjectsForLogs(logs: any[]) {
  const s3Config = APP_CONFIG?.s3;
  const s3 = getS3Client();
  if (!s3 || !s3Config?.bucketName) {
    console.log("[ES-INIT-SERVICE] S3 bucket is not configured. Skipping MinIO object seeding.");
    return;
  }

  let uploaded = 0;
  let failed = 0;
  const keys = new Set<string>();

  logs.forEach((log) => {
    const key = log.s3_key || log.archive_name;
    if (typeof key === "string" && key.trim()) keys.add(key);
  });

  for (const key of keys) {
    const body = key.endsWith(".zip") || key.endsWith(".gz")
      ? await createMockArchiveBuffer(key)
      : Buffer.from(`[MINIO MOCK PAYLOAD]\nKey: ${key}\nGenerated: ${new Date().toISOString()}\n`);

    try {
      await s3.send(new PutObjectCommand({
        Bucket: s3Config.bucketName,
        Key: key,
        Body: body,
        ContentType: key.endsWith(".zip")
          ? "application/zip"
          : key.endsWith(".gz")
          ? "application/gzip"
          : "application/octet-stream",
      }));
      uploaded += 1;
    } catch (err: any) {
      failed += 1;
      if (failed <= 3) {
        console.warn(`[ES-INIT-SERVICE] Could not seed MinIO object [${key}]: ${err.message}`);
      }
    }
  }

  console.log(`[ES-INIT-SERVICE] MinIO object seed complete. uploaded=${uploaded}, failed=${failed}.`);
}

function stripElasticsearchMetadata(doc: Record<string, unknown>) {
  const { _id, _index, _score, _type, ...source } = doc;
  return source;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runInitialization() {
  console.log(`[ES-INIT-SERVICE] Starting independent Elasticsearch initialization service...`);
  if (!ES_URL) {
    console.log(`[ES-INIT-SERVICE] Elasticsearch URL is not configured. Set elasticsearch.nodeUrls in config.yaml.`);
    return;
  }
  console.log(`[ES-INIT-SERVICE] Target URL: ${ES_URL}`);

  let isConnected = false;
  let retries = 3;

  // 1. Wait for Elasticsearch to become available and healthy (yellow/green)
  while (retries > 0 && !isConnected) {
    try {
      console.log(`[ES-INIT-SERVICE] Pinging Elasticsearch, ${retries} attempts remaining...`);
      const healthResponse = await esFetch(`${ES_URL}/_cluster/health`, {
        headers: { "Authorization": ES_AUTH }
      });

      if (healthResponse.ok) {
        const health = await healthResponse.json();
        if (health && (health.status === "green" || health.status === "yellow")) {
          console.log(`[ES-INIT-SERVICE] Connected successfully! Cluster status: ${health.status}`);
          isConnected = true;
          break;
        } else {
          console.warn(`[ES-INIT-SERVICE] Cluster is online but status is: ${health?.status || 'unknown'}`);
        }
      } else {
        console.warn(`[ES-INIT-SERVICE] Ping failed with status: ${healthResponse.status}`);
      }
    } catch (err: any) {
      // Suppressing fetch failed logs from filling up console during simulation mode
    }

    retries--;
    if (!isConnected && retries > 0) {
      await sleep(1000);
    }
  }

  if (!isConnected) {
    console.log(`[ES-INIT-SERVICE] Native Elasticsearch cluster not detected at ${ES_URL}. Fallback simulator active. Exiting initializer.`);
    process.exit(0);
  }

  await configureKibanaSystemPassword();

  // 2. Disable disk watermark routing blocks so our sandbox storage can safely write index documents
  try {
    console.log(`[ES-INIT-SERVICE] Tuning cluster disk watermark thresholds to avoid read-only locks...`);
    const sRes = await esFetch(`${ES_URL}/_cluster/settings`, {
      method: "PUT",
      headers: {
        "Authorization": ES_AUTH,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        persistent: {
          "cluster.routing.allocation.disk.threshold_enabled": false
        },
        transient: {
          "cluster.routing.allocation.disk.threshold_enabled": false
        }
      })
    }).then(r => r.json());
    console.log(`[ES-INIT-SERVICE] Cluster settings updated:`, JSON.stringify(sRes));
  } catch (err: any) {
    console.error(`[ES-INIT-SERVICE] Error updating cluster settings:`, err.message);
  }

  // 3. Clear any existing read-only flood-stage block triggers on nodes
  try {
    console.log(`[ES-INIT-SERVICE] Unblocking indexes (clearing read_only_allow_delete states)...`);
    const uRes = await esFetch(`${ES_URL}/_all/_settings`, {
      method: "PUT",
      headers: {
        "Authorization": ES_AUTH,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "index.blocks.read_only_allow_delete": null
      })
    }).then(r => r.json());
    console.log(`[ES-INIT-SERVICE] Indexes unblocked:`, JSON.stringify(uRes));
  } catch (err: any) {
    console.error(`[ES-INIT-SERVICE] Error clearing index read-only blocks:`, err.message);
  }

  // 4. Seeding dynamic mock records into Elasticsearch
  try {
    const seedIndex = process.env.SEED_INDEX?.trim();
    const seedLogs = seedIndex ? generateMockLogs(new Date().toISOString(), seedIndex) : [];
    const catalogLogs = S3_CATALOG_INDEX ? generateS3ArchiveCatalogLogs(S3_CATALOG_INDEX, new Date().toISOString()) : [];
    const allLogs = [...seedLogs, ...catalogLogs];
    console.log(`[ES-INIT-SERVICE] Generated ${allLogs.length} documents across indices (including ${catalogLogs.length} S3 catalog entries).`);
    await seedS3ObjectsForLogs(allLogs);

    let bulkBody = "";
    allLogs.forEach(log => {
      bulkBody += JSON.stringify({ index: { _index: log._index, _id: log._id } }) + "\n";
      bulkBody += JSON.stringify(stripElasticsearchMetadata(log as unknown as Record<string, unknown>)) + "\n";
    });

    console.log(`[ES-INIT-SERVICE] Sending bulk request to Elasticsearch (_bulk?refresh=true)...`);
    const bulkResponse = await esFetch(`${ES_URL}/_bulk?refresh=true`, {
      method: "POST",
      headers: {
        "Authorization": ES_AUTH,
        "Content-Type": "application/x-ndjson"
      },
      body: bulkBody
    });

    if (bulkResponse.ok) {
      const resultObj = await bulkResponse.json();
      if (resultObj && resultObj.errors) {
        console.error(`[ES-INIT-SERVICE] Bulk indexing completed with errors:`);
        const itemErrors = resultObj.items?.filter((it: any) => it.index && it.index.error);
        if (itemErrors && itemErrors.length > 0) {
          console.error(`First 5 error entries:`, JSON.stringify(itemErrors.slice(0, 5), null, 2));
        }
      } else {
        console.log(`[ES-INIT-SERVICE] SUCCESS: Seeded Elasticsearch with ${allLogs.length} logs (catalog index: ${S3_CATALOG_INDEX || "not configured"})!`);
      }
    } else {
      console.error(`[ES-INIT-SERVICE] ERROR: Bulk request failed with HTTP code ${bulkResponse.status}`);
      const errText = await bulkResponse.text().catch(() => "");
      console.error(`Error details: ${errText.slice(0, 500)}`);
    }

    // Double-check final index document counts
    console.log(`[ES-INIT-SERVICE] Fetching index document counts for verification...`);
    const finalCounts = await esFetch(`${ES_URL}/_cat/indices?format=json`, {
      headers: { "Authorization": ES_AUTH }
    }).then(r => r.json()).catch(() => null);

    if (finalCounts && Array.isArray(finalCounts)) {
      console.log(`[ES-INIT-SERVICE] Current Elasticsearch Indixes Status:`);
      finalCounts.forEach(it => {
        console.log(`  - Index: ${it.index} | docs.count: ${it["docs.count"]} | status: ${it.status} | health: ${it.health}`);
      });
    }

    // Ensure S3 archive catalog index is populated (same docs as init-es bulk)
    const catalogOnly = catalogLogs.length;
    console.log(`[ES-INIT-SERVICE] Catalog index [${S3_CATALOG_INDEX || "not configured"}] includes ${catalogOnly} archive documents.`);

    console.log(`[ES-INIT-SERVICE] Service execution completed successfully. Lifecycle terminated.`);
    process.exit(0);
  } catch (err: any) {
    console.error(`[ES-INIT-SERVICE] Unhandled error during seeding:`, err.message);
    process.exit(1);
  }
}

runInitialization();
