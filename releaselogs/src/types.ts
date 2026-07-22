/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LogRecord {
  _id: string;
  _index: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  method: string;
  status: number;
  request_path: string;
  ip: string;
  bytes: number;
  country: string;
  user_agent: string;
  download_url: string;
  archive_name: string;
  /** Full S3 object key (e.g. snaps/daily-log-backup_2026-05-24.zip) */
  s3_key?: string;
  size_bytes?: number;
  content_type?: string;
  description?: string;
}

export interface LinkRule {
  columnName: string;
  urlTemplate: string; // e.g. "https://my-monitoring.com/trace/{value}" or just "{value}"
  labelTemplate: string; // e.g. "Trace: {value}" or just "{value}"
  openInNewTab: boolean;
  colorScheme: 'default' | 'blue' | 'emerald' | 'amber' | 'indigo' | 'rose';
}

export interface QueryFilter {
  queryText: string;
  timestampRange: {
    from: string; // ISO string or relative key like 'now-15m'
    to: string;   // ISO string or 'now'
    label: string; // Human readable like "Last 15 minutes"
  };
  levels: string[]; // info, warn, error
}

export interface DiscoverConfig {
  defaultIndex: string;
  linkRules: LinkRule[];
  s3CatalogIndex?: string;
}

export interface IndexPattern {
  name: string;
  description: string;
  count: number;
}

export interface User {
  id: string;
  username: string;
  fullName: string;
  email: string;
  role: 'super_admin' | 'observer';
  type: 'local' | 'ldap';
  createdOn: string;
  department?: string;
}

export interface LDAPConfig {
  ldapUrl?: string;
  userDnPattern?: string;
  emailAttribute?: string;
  searchFilter?: string;
  searchBase?: string;
  managerDn?: string;
  managerPassword?: string;
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
}

export interface ElasticsearchConfig {
  nodeUrls: string;
  authMethod: 'anonymous' | 'basic' | 'token';
  username?: string;
  password?: string;
  token?: string;
  enableSSL: boolean;
  verifyServerCertificate: boolean;
  clientCertificateName?: string;
  clientCertificateContent?: string;
  clientKeyName?: string;
  clientKeyContent?: string;
  caCertificateName?: string;
  caCertificateContent?: string;
  clusterName: string;
  shardsCount: number;
  replicasCount: number;
}

export interface S3Config {
  endpointUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  region: string;
  enableSSL: boolean;
  verifyCertificates: boolean;
  caCertificateName?: string;
  caCertificateContent?: string;
  forcePathStyle: boolean;
  catalogIndex: string;
}

export interface S3File {
  key: string;
  size: number;
  lastModified: string;
  contentType: string;
  etag?: string;
  description?: string;
  download_url?: string;
}
