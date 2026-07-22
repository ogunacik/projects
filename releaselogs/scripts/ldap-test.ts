#!/usr/bin/env tsx
import fs from "fs";
import path from "path";
import net from "net";
import tls from "tls";
import * as yaml from "js-yaml";

type LDAPConfig = {
  serverUrl: string;
  bindDn: string;
  bindPassword?: string;
  baseDn: string;
  userSearchFilter: string;
  groupSearchFilter: string;
  enableSSL: boolean;
  verifyCertificates: boolean;
  caCertificateName?: string;
  caCertificateContent?: string;
  activeDirectoryMode: boolean;
};

type AppConfig = {
  ldap: LDAPConfig;
};

const DATA_DIR = process.env.APP_DATA_DIR || path.join(process.cwd(), "data");
const TEMPLATE_CONFIG_PATH = path.join(process.cwd(), "config.yaml");
const RUNTIME_CONFIG_PATH = process.env.CONFIG_PATH || path.join(DATA_DIR, "config.yaml");
const CONFIG_PATH = fs.existsSync(RUNTIME_CONFIG_PATH) ? RUNTIME_CONFIG_PATH : TEMPLATE_CONFIG_PATH;

function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const loaded = (yaml.load(raw) as Partial<AppConfig>) || {};
  if (!loaded.ldap) throw new Error("LDAP configuration is missing from config.yaml");
  return {
    ldap: {
      serverUrl: loaded.ldap.serverUrl || "",
      bindDn: loaded.ldap.bindDn || "",
      bindPassword: loaded.ldap.bindPassword || "",
      baseDn: loaded.ldap.baseDn || "",
      userSearchFilter: loaded.ldap.userSearchFilter || "(uid={username})",
      groupSearchFilter: loaded.ldap.groupSearchFilter || "",
      enableSSL: loaded.ldap.enableSSL ?? false,
      verifyCertificates: loaded.ldap.verifyCertificates ?? false,
      caCertificateName: loaded.ldap.caCertificateName || "",
      caCertificateContent: loaded.ldap.caCertificateContent || "",
      activeDirectoryMode: loaded.ldap.activeDirectoryMode ?? false,
    },
  };
}

function ldapEncodeLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function ldapTlv(tag: number, value: Buffer) {
  return Buffer.concat([Buffer.from([tag]), ldapEncodeLength(value.length), value]);
}

function ldapInt(value: number) {
  if (value === 0) return ldapTlv(0x02, Buffer.from([0]));
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return ldapTlv(0x02, Buffer.from(bytes));
}

function ldapEnum(value: number) {
  return ldapTlv(0x0a, Buffer.from([value]));
}

function ldapBool(value: boolean) {
  return ldapTlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function ldapString(value: string, tag = 0x04) {
  return ldapTlv(tag, Buffer.from(value, "utf8"));
}

function ldapSequence(...parts: Buffer[]) {
  return ldapTlv(0x30, Buffer.concat(parts));
}

function readBerLength(buffer: Buffer, offset: number) {
  const first = buffer[offset];
  if (first < 0x80) return { length: first, bytes: 1 };
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = (length << 8) | buffer[offset + 1 + i];
  return { length, bytes: 1 + count };
}

function readBerElement(buffer: Buffer, offset = 0) {
  const tag = buffer[offset];
  const len = readBerLength(buffer, offset + 1);
  const start = offset + 1 + len.bytes;
  return { tag, value: buffer.subarray(start, start + len.length), next: start + len.length };
}

function ldapMessage(messageId: number, protocolOp: Buffer) {
  return ldapSequence(ldapInt(messageId), protocolOp);
}

function ldapBindRequest(messageId: number, dn: string, password: string) {
  return ldapMessage(messageId, ldapTlv(0x60, Buffer.concat([ldapInt(3), ldapString(dn), ldapString(password, 0x80)])));
}

function ldapSearchRequest(messageId: number, baseDn: string, filter: string, attributes: string[]) {
  return ldapMessage(
    messageId,
    ldapTlv(
      0x63,
      Buffer.concat([
        ldapString(baseDn),
        ldapEnum(2),
        ldapEnum(0),
        ldapInt(25),
        ldapInt(10),
        ldapBool(false),
        encodeLdapFilter(filter),
        ldapSequence(...attributes.map((attr) => ldapString(attr))),
      ])
    )
  );
}

type LdapFilterNode = { op: "&" | "|"; children: LdapFilterNode[] } | { op: "="; attr: string; value: string };

function parseLdapFilter(filter: string): LdapFilterNode {
  let pos = 0;
  const skip = () => { while (/\s/.test(filter[pos] || "")) pos++; };
  const parse = (): LdapFilterNode => {
    skip();
    if (filter[pos++] !== "(") throw new Error("LDAP filter must start with '('");
    skip();
    const op = filter[pos];
    if (op === "&" || op === "|") {
      pos++;
      const children: LdapFilterNode[] = [];
      while (filter[pos] !== ")") children.push(parse());
      pos++;
      return { op, children };
    }
    const end = filter.indexOf(")", pos);
    if (end === -1) throw new Error("LDAP filter missing closing ')'");
    const expr = filter.slice(pos, end);
    pos = end + 1;
    const eq = expr.indexOf("=");
    if (eq <= 0) throw new Error(`Unsupported LDAP filter expression: ${expr}`);
    return { op: "=", attr: expr.slice(0, eq), value: expr.slice(eq + 1) };
  };
  return parse();
}

function encodeLdapFilter(filter: string): Buffer {
  const encode = (node: LdapFilterNode): Buffer => {
    if (node.op === "&") return ldapTlv(0xa0, Buffer.concat(node.children.map(encode)));
    if (node.op === "|") return ldapTlv(0xa1, Buffer.concat(node.children.map(encode)));
    const eqNode = node as { op: "="; attr: string; value: string };
    return ldapTlv(0xa3, ldapSequence(ldapString(eqNode.attr), ldapString(eqNode.value)));
  };
  return encode(parseLdapFilter(filter));
}

function parseLdapSearchEntry(protocolValue: Buffer) {
  let offset = 0;
  const dnElement = readBerElement(protocolValue, offset);
  const dn = dnElement.value.toString("utf8");
  offset = dnElement.next;
  const attrsElement = readBerElement(protocolValue, offset);
  const attrs: Record<string, string[]> = {};
  let attrOffset = 0;
  while (attrOffset < attrsElement.value.length) {
    const attrSeq = readBerElement(attrsElement.value, attrOffset);
    attrOffset = attrSeq.next;
    const nameElement = readBerElement(attrSeq.value, 0);
    const name = nameElement.value.toString("utf8");
    const valsElement = readBerElement(attrSeq.value, nameElement.next);
    const vals: string[] = [];
    let valOffset = 0;
    while (valOffset < valsElement.value.length) {
      const val = readBerElement(valsElement.value, valOffset);
      valOffset = val.next;
      vals.push(val.value.toString("utf8"));
    }
    attrs[name] = vals;
  }
  return { dn, attrs };
}

function ldapParseResultCode(protocolValue: Buffer) {
  const result = readBerElement(protocolValue, 0);
  return readBerInteger(result.value);
}

function readBerInteger(buffer: Buffer) {
  let value = 0;
  for (const byte of buffer) value = (value << 8) | byte;
  return value;
}

async function ldapRoundTrip(config: LDAPConfig, request: Buffer, doneTags: number[]) {
  const parsedUrl = new URL(config.serverUrl);
  const port = Number(parsedUrl.port || (parsedUrl.protocol === "ldaps:" ? 636 : 389));
  const host = parsedUrl.hostname;
  const useTls = parsedUrl.protocol === "ldaps:" || config.enableSSL;
  const ca = config.caCertificateContent?.trim() ? [config.caCertificateContent] : undefined;

  return new Promise<Array<{ tag: number; value: Buffer }>>((resolve, reject) => {
    const socket = useTls
      ? tls.connect({ host, port, rejectUnauthorized: config.verifyCertificates, ca })
      : net.connect({ host, port });
    const responses: Array<{ tag: number; value: Buffer }> = [];
    let buffer = Buffer.alloc(0);
    let wroteRequest = false;

    const writeRequest = () => {
      if (!wroteRequest) {
        wroteRequest = true;
        socket.write(request);
      }
    };

    const failTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`LDAP request timed out connecting to ${host}:${port}`));
    }, 10000);

    socket.on(useTls ? "secureConnect" : "connect", writeRequest);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const len = readBerLength(buffer, 1);
        const total = 1 + len.bytes + len.length;
        if (buffer.length < total) break;
        const msg = readBerElement(buffer, 0);
        buffer = buffer.subarray(total);
        const idElement = readBerElement(msg.value, 0);
        const protocol = readBerElement(msg.value, idElement.next);
        responses.push({ tag: protocol.tag, value: protocol.value });
        if (doneTags.includes(protocol.tag)) {
          clearTimeout(failTimer);
          socket.end();
          resolve(responses);
          return;
        }
      }
    });
    socket.on("error", (err) => {
      clearTimeout(failTimer);
      reject(err);
    });
  });
}

async function ldapBind(config: LDAPConfig, dn: string, password: string) {
  const responses = await ldapRoundTrip(config, ldapBindRequest(Date.now() % 100000, dn, password), [0x61]);
  const bindResponse = responses.find((response) => response.tag === 0x61);
  if (!bindResponse || ldapParseResultCode(bindResponse.value) !== 0) {
    throw new Error("LDAP bind failed.");
  }
}

async function ldapSearch(config: LDAPConfig, baseDn: string, filter: string, attributes: string[]) {
  const responses = await ldapRoundTrip(config, ldapSearchRequest(Date.now() % 100000, baseDn, filter, attributes), [0x65]);
  const done = responses.find((response) => response.tag === 0x65);
  if (done && ldapParseResultCode(done.value) !== 0) throw new Error("LDAP search failed.");
  return responses.filter((response) => response.tag === 0x64).map((response) => parseLdapSearchEntry(response.value));
}

async function main() {
  console.log(`Using runtime config path: ${CONFIG_PATH}`);
  if (CONFIG_PATH !== RUNTIME_CONFIG_PATH && fs.existsSync(RUNTIME_CONFIG_PATH)) {
    console.log(`Note: runtime config(${RUNTIME_CONFIG_PATH}) exists, but the script is using ${CONFIG_PATH} because RUNTIME_CONFIG_PATH was not selected by environment.`);
  }

  const config = loadConfig();
  console.log("LDAP configuration:", {
    serverUrl: config.ldap.serverUrl,
    bindDn: config.ldap.bindDn,
    baseDn: config.ldap.baseDn,
    userSearchFilter: config.ldap.userSearchFilter,
    enableSSL: config.ldap.enableSSL,
    verifyCertificates: config.ldap.verifyCertificates,
    caCertificateConfigured: Boolean(config.ldap.caCertificateContent?.trim() || config.ldap.caCertificateName?.trim()),
  });

  if (config.ldap.verifyCertificates && !config.ldap.caCertificateContent?.trim()) {
    console.warn("Warning: LDAP verifyCertificates=true but no CA certificate content is configured.");
  }

  const username = process.argv[2] || "ada.lovelace";
  const password = process.argv[3] || "Password1!";

  console.log(`\nTesting LDAP admin bind for ${config.ldap.bindDn}...`);
  await ldapBind(config.ldap, config.ldap.bindDn, config.ldap.bindPassword || "");
  console.log("Admin bind succeeded.");

  const userFilter = config.ldap.userSearchFilter.replace("{username}", username);
  console.log(`Searching for user ${username} with filter ${userFilter}...`);
  const users = await ldapSearch(config.ldap, config.ldap.baseDn, userFilter, ["dn", "cn", "uid", "mail"]);
  if (users.length === 0) {
    throw new Error(`No LDAP users found for ${username}`);
  }

  const user = users[0];
  console.log("Found LDAP user:", { dn: user.dn, attrs: user.attrs });
  console.log(`Testing bind for ${user.dn}...`);
  await ldapBind(config.ldap, user.dn, password);
  console.log("User bind succeeded.");
}

main().catch((err) => {
  console.error("LDAP test failed:", err.message || err);
  process.exit(1);
});
