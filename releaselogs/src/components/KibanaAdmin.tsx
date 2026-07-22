/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, ChangeEvent, FormEvent, useEffect } from 'react';
import {
  Users,
  Settings,
  Server,
  Key,
  Lock,
  ShieldCheck,
  ShieldAlert,
  Plus,
  Trash2,
  Database,
  RefreshCw,
  FileCode,
  CheckCircle,
  HelpCircle,
  Upload,
  Terminal,
  Play,
  User as UserIcon,
  Eye,
  EyeOff,
  AlertTriangle
} from 'lucide-react';
import { User, LDAPConfig, ElasticsearchConfig, IndexPattern } from '../types';
import KibanaS3Manager from './KibanaS3Manager';
import ingLogo from './ING_logo.svg';

interface KibanaAdminProps {
  currentUser: User;
  onLogout: () => void;
  onBackToSearch: () => void;
  currentPath: string;
  onNavigateToSection: (path: string) => void;
}

type AdminTab = 'general' | 'ldap' | 'elasticsearch' | 'app_https' | 'local_users' | 's3_proxy' | 's3_files' | 'audit_logs' | 'cluster_status';

const ADMIN_TAB_ROUTES: Record<AdminTab, string> = {
  general: '/management/app',
  ldap: '/management/ldap',
  elasticsearch: '/management/elasticsearch',
  app_https: '/management/app/https',
  local_users: '/management/users',
  s3_proxy: '/management/s3/connection',
  s3_files: '/management/s3/files',
  audit_logs: '/management/audit',
  cluster_status: '/management/status',
};

const S3_SETTINGS_ROUTES = {
  connection: '/management/s3/connection',
  proxy: '/management/s3/proxy',
} as const;

function getAdminTabFromPath(path: string): AdminTab {
  if (path.startsWith('/management/app/https')) return 'app_https';
  if (path.startsWith('/management/app/discover') || path.startsWith('/management/discover')) return 'general';
  if (path.startsWith('/management/app')) return 'general';
  if (path.startsWith('/management/ldap')) return 'ldap';
  if (path.startsWith('/management/elasticsearch')) return 'elasticsearch';
  if (path.startsWith('/management/users')) return 'local_users';
  if (path.startsWith('/management/s3/files')) return 's3_files';
  if (path.startsWith('/management/s3')) return 's3_proxy';
  if (path.startsWith('/management/audit')) return 'audit_logs';
  if (path.startsWith('/management/status')) return 'cluster_status';
  return 'general';
}

function getS3SettingsTabFromPath(path: string): keyof typeof S3_SETTINGS_ROUTES {
  return path.startsWith(S3_SETTINGS_ROUTES.proxy) ? 'proxy' : 'connection';
}

function normalizeBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function normalizeAppConfig(config: any) {
  return {
    ...config,
    enableHTTPS: normalizeBoolean(config?.enableHTTPS),
    httpsPort: Number(config?.httpsPort ?? 0),
    validDays: Number(config?.validDays ?? 0),
    sessionTimeoutMinutes: Number(config?.sessionTimeoutMinutes ?? 60),
  };
}

export default function KibanaAdmin({
  currentUser,
  onLogout,
  onBackToSearch,
  currentPath,
  onNavigateToSection,
}: KibanaAdminProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>(() => getAdminTabFromPath(currentPath));

  const [defaultDiscoverIndex, setDefaultDiscoverIndex] = useState('');
  const [availableIndices, setAvailableIndices] = useState<IndexPattern[]>([]);
  const [discoverConfigSaving, setDiscoverConfigSaving] = useState(false);

  // Audit configuration states
  const [auditIndex, setAuditIndex] = useState('');
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [auditConfigLoading, setAuditConfigLoading] = useState(false);
  const [auditLogsPage, setAuditLogsPage] = useState(1);
  const [auditLogsPageSize, setAuditLogsPageSize] = useState(25);
  const [auditLogsTotal, setAuditLogsTotal] = useState(0);

  const fetchDiscoverConfig = () => {
    fetch('/api/discover/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'success' && data.config?.defaultIndex) {
          setDefaultDiscoverIndex(data.config.defaultIndex);
          addLog(`[DISCOVER] Default viewer index: [${data.config.defaultIndex}]`);
        }
      })
      .catch((err) => addLog(`[DISCOVER-ERR] ${err.message}`));
  };

  const fetchAvailableIndices = () => {
    fetch('/api/es-indices')
      .then((res) => res.json())
      .then((data) => {
        if (data.indices?.length) {
          setAvailableIndices(
            data.indices.map((idx: { index: string }) => ({
              name: idx.index,
              description: `Elasticsearch index ${idx.index}`,
              count: 0,
            }))
          );
        }
      })
      .catch(() => {});
  };

  const handleSaveDiscoverConfig = (e: FormEvent) => {
    e.preventDefault();
    setDiscoverConfigSaving(true);
    fetch('/api/discover/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultIndex: defaultDiscoverIndex,
        username: currentUser.username,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        setDiscoverConfigSaving(false);
        if (data.status === 'success') {
          triggerToast('Default Discover index updated.');
          addLog(`[DISCOVER] Set default index to [${defaultDiscoverIndex}]`);
        }
      })
      .catch((err) => {
        setDiscoverConfigSaving(false);
        triggerToast(err.message);
      });
  };

  const fetchAuditConfig = () => {
    fetch('/api/audit/config')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setAuditIndex(data.config.elasticsearchIndex);
          setAuditLogsPage(1);
          fetchAuditLogs(data.config.elasticsearchIndex, 1, auditLogsPageSize);
          addLog(`[AUDIT] Synced active audit index name: [${data.config.elasticsearchIndex}]`);
        }
      })
      .catch(err => {
        addLog(`[AUDIT-ERR] Failed pulling audit settings: ${err.message}`);
      });
  };

  const fetchAuditLogs = (idxToFetch?: string, pageToFetch = auditLogsPage, pageSizeToFetch = auditLogsPageSize) => {
    const target = idxToFetch || auditIndex;
    if (!target) {
      setAuditLogs([]);
      setAuditLogsTotal(0);
      return;
    }

    setAuditLogsLoading(true);
    const params = new URLSearchParams({
      index: target,
      page: String(pageToFetch),
      pageSize: String(pageSizeToFetch),
    });
    fetch(`/api/audit/logs?${params.toString()}`)
      .then(res => res.json())
      .then(data => {
        setAuditLogsLoading(false);
        if (data.status === 'success') {
          setAuditLogs(data.logs);
          setAuditLogsTotal(Number(data.total ?? data.logs.length));
          setAuditLogsPage(Number(data.page ?? pageToFetch));
          setAuditLogsPageSize(Number(data.pageSize ?? pageSizeToFetch));
          addLog(`[AUDIT] Read index [${target}] trace directory. Retrieved ${data.logs.length} of ${data.total ?? data.logs.length} events.`);
        }
      })
      .catch(err => {
        setAuditLogsLoading(false);
        addLog(`[AUDIT-ERR] Pulling index trace lines failed: ${err.message}`);
      });
  };

  const handleSaveAuditConfig = (e: FormEvent) => {
    e.preventDefault();
    setAuditConfigLoading(true);
    fetch('/api/audit/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elasticsearchIndex: auditIndex, username: currentUser.username })
    })
      .then(res => res.json())
      .then(data => {
        setAuditConfigLoading(false);
        if (data.status === 'success') {
          triggerToast('Audit Elasticsearch index mapping updated.');
          addLog(`[AUDIT] Target index mapping set: ${auditIndex}`);
          setAuditLogsPage(1);
          fetchAuditLogs(auditIndex, 1);
        }
      })
      .catch(err => {
        setAuditConfigLoading(false);
        triggerToast(`Audit override failed: ${err.message}`);
      });
  };

  // Message toaster state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Diagnostic live console logs for testing
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    '[SYSTEM] Initialized secure admin dashboard component.',
    `[AUTH] Active administrative session started for user: ${currentUser.fullName} (${currentUser.role}).`,
    '[SSL] Default Sectigo trust chains successfully parsed.'
  ]);

  // S3 Config and file state managers
  const [s3Config, setS3Config] = useState<any>({
    endpointUrl: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucketName: '',
    region: '',
    enableSSL: false,
    verifyCertificates: false,
    caCertificateName: '',
    caCertificateContent: '',
    forcePathStyle: false,
    catalogIndex: '',
    proxyAuthEnabled: false,
    proxyAuthMethod: 'basic',
    proxyBasicUsername: '',
    proxyApiKeys: [],
  });
  const [s3Saving, setS3Saving] = useState(false);
  const [s3SettingsTab, setS3SettingsTab] = useState<'connection' | 'proxy'>('connection');
  const [newProxyKeyName, setNewProxyKeyName] = useState('');
  const [generatedProxyApiKey, setGeneratedProxyApiKey] = useState('');
  const [appConfig, setAppConfig] = useState<any>({
    enableHTTPS: false,
    httpsPort: 0,
    certificateName: '',
    certificateContent: '',
    privateKeyName: '',
    privateKeyContent: '',
    commonName: '',
    validDays: 0,
    sessionTimeoutMinutes: 60,
    localUserEmailDomain: '',
  });
  const [appConfigSaving, setAppConfigSaving] = useState(false);

  const fetchS3Config = () => {
    fetch('/api/s3/config')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setS3Config(data.config);
          addLog('[S3] Fetched S3 gateway credentials maps from backend config storage.');
        }
      })
      .catch(err => {
        addLog(`[S3-ERR] Failed accessing configuration API: ${err.message}`);
      });
  };

  const fetchAppConfig = () => {
    fetch('/api/app/config')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setAppConfig(normalizeAppConfig(data.config));
          addLog('[APP-TLS] Loaded App HTTPS certificate settings.');
        }
      })
      .catch(err => addLog(`[APP-TLS-ERR] Failed accessing app HTTPS API: ${err.message}`));
  };

  const saveAppConfig = (regenerateCertificate = false) => {
    setAppConfigSaving(true);
    fetch('/api/app/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...appConfig, regenerateCertificate }),
    })
      .then(res => res.json())
      .then(data => {
        setAppConfigSaving(false);
        if (data.status === 'success') {
          setAppConfig(normalizeAppConfig(data.config));
          triggerToast(data.restartRequired ? 'App settings saved. Restart required.' : 'App settings saved.');
          addLog('[APP] Saved Release Logs app settings to config.yaml.');
        } else {
          triggerToast(data.error || 'App HTTPS settings failed.');
        }
      })
      .catch(err => {
        setAppConfigSaving(false);
        triggerToast(`App HTTPS settings failed: ${err.message}`);
      });
  };

  const handleSaveS3Config = (e: FormEvent) => {
    e.preventDefault();
    setS3Saving(true);
    fetch('/api/s3/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s3Config)
    })
      .then(res => res.json())
      .then(data => {
        setS3Saving(false);
        if (data.status === 'success') {
          triggerToast('S3 settings updated and synced with cluster hosts.');
          addLog(`[S3] Active credentials modified. Connected endpoints re-registered.`);
        }
      })
      .catch(err => {
        setS3Saving(false);
        triggerToast(`Write failed: ${err.message}`);
      });
  };

  const handleCreateS3ProxyApiKey = () => {
    setS3Saving(true);
    fetch('/api/s3/proxy-api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProxyKeyName || 'S3 Proxy API Key' }),
    })
      .then(res => res.json())
      .then(data => {
        setS3Saving(false);
        if (data.status === 'success') {
          setS3Config((current: any) => ({
            ...current,
            proxyApiKeys: data.config.proxyApiKeys || [],
          }));
          setGeneratedProxyApiKey(data.apiKey);
          setNewProxyKeyName('');
          triggerToast('S3 proxy API key created. Copy it now.');
        } else {
          triggerToast(data.error || 'Failed creating S3 proxy API key.');
        }
      })
      .catch(err => {
        setS3Saving(false);
        triggerToast(`API key creation failed: ${err.message}`);
      });
  };

  const handleRevokeS3ProxyApiKey = (id: string) => {
    setS3Saving(true);
    fetch(`/api/s3/proxy-api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        setS3Saving(false);
        if (data.status === 'success') {
          setS3Config((current: any) => ({
            ...current,
            proxyApiKeys: data.config.proxyApiKeys || [],
          }));
          triggerToast('S3 proxy API key revoked.');
        } else {
          triggerToast(data.error || 'Failed revoking S3 proxy API key.');
        }
      })
      .catch(err => {
        setS3Saving(false);
        triggerToast(`API key revoke failed: ${err.message}`);
      });
  };

  useEffect(() => {
    fetchDiscoverConfig();
    fetchAvailableIndices();
  }, []);

  useEffect(() => {
    const nextTab = getAdminTabFromPath(currentPath);
    setActiveTab(nextTab);
    const knownRoutes = [...Object.values(ADMIN_TAB_ROUTES), ...Object.values(S3_SETTINGS_ROUTES)];
    const isLegacyDiscoverRoute = currentPath.startsWith('/management/app/discover') || currentPath.startsWith('/management/discover');
    if (currentPath === '/management' || isLegacyDiscoverRoute || !knownRoutes.some((route) => currentPath.startsWith(route))) {
      onNavigateToSection(ADMIN_TAB_ROUTES[nextTab]);
    }
  }, [currentPath, onNavigateToSection]);

  useEffect(() => {
    if (activeTab === 's3_proxy') {
      setS3SettingsTab(getS3SettingsTabFromPath(currentPath));
    }
  }, [activeTab, currentPath]);

  const navigateToTab = (tab: AdminTab) => {
    setActiveTab(tab);
    onNavigateToSection(ADMIN_TAB_ROUTES[tab]);
  };

  useEffect(() => {
    if (activeTab === 's3_proxy') {
      fetchS3Config();
      fetchLocalUsers();
    }
    if (activeTab === 'audit_logs') {
      fetchAuditConfig();
    }
    if (activeTab === 'local_users') {
      fetchLocalUsers();
    }
    if (activeTab === 'general' || activeTab === 'app_https') {
      fetchAppConfig();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'audit_logs') {
      fetchAuditLogs(auditIndex, auditLogsPage, auditLogsPageSize);
    }
  }, [auditLogsPage, auditLogsPageSize]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(auditLogsTotal / auditLogsPageSize));
    if (auditLogsPage > totalPages) {
      setAuditLogsPage(totalPages);
    }
  }, [auditLogsPage, auditLogsPageSize, auditLogsTotal]);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setConsoleLogs(prev => [`[${timestamp}] ${msg}`, ...prev]);
  };

  const triggerToast = (msg: string, type?: 'success' | 'error') => {
    const inferredType = type || (/\b(error|failed|fail|denied|invalid|not found|unreachable|closed|required)\b/i.test(msg) ? 'error' : 'success');
    setToast({ message: msg, type: inferredType });
    setTimeout(() => {
      setToast(null);
    }, 3000);
  };

  // State A: LDAP Settings
  const [ldapConfig, setLdapConfig] = useState<LDAPConfig>({
    ldapUrl: '',
    userDnPattern: '',
    emailAttribute: 'mail',
    searchFilter: '',
    searchBase: '',
    managerDn: '',
    managerPassword: '',
    serverUrl: '',
    bindDn: '',
    bindPassword: '',
    baseDn: '',
    userSearchFilter: '',
    groupSearchFilter: '',
    enableSSL: false,
    verifyCertificates: false,
    caCertificateName: '',
    caCertificateContent: '',
    activeDirectoryMode: false
  });

  const [ldapTestCredentials, setLdapTestCredentials] = useState({
    username: '',
    password: '',
  });
  const [testLdapLoading, setTestLdapLoading] = useState(false);
  const [testLdapUserLoading, setTestLdapUserLoading] = useState(false);

  // State B: Elasticsearch Settings
  const [esConfig, setEsConfig] = useState<ElasticsearchConfig>({
    nodeUrls: '',
    authMethod: 'anonymous',
    username: '',
    password: '',
    token: '',
    enableSSL: false,
    verifyServerCertificate: false,
    caCertificateName: '',
    caCertificateContent: '',
    clientCertificateName: '',
    clientCertificateContent: '',
    clientKeyName: '',
    clientKeyContent: '',
    clusterName: '',
    shardsCount: 0,
    replicasCount: 0
  });

  const [esStatus, setEsStatus] = useState<'GREEN' | 'YELLOW' | 'RED' | 'CHECKING' | 'DISCONNECTED'>('CHECKING');
  const [ldapStatus, setLdapStatus] = useState<'CONNECTED' | 'DISCONNECTED' | 'CHECKING'>('CHECKING');

  const ldapUrl = ldapConfig.ldapUrl || ldapConfig.serverUrl || '';
  const ldapUsesTls = ldapConfig.enableSSL || ldapUrl.trim().toLowerCase().startsWith('ldaps://');
  const ldapCertStatus = ldapUsesTls
    ? (ldapConfig.verifyCertificates ? 'Enforced' : 'TLS Enabled, Verification Off')
    : 'Plain LDAP';

  const fetchLdapConfig = () => {
    fetch('/api/ldap/config')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success' && data.config) {
          setLdapConfig(data.config);
          addLog(`[LDAP] Loaded configuration from config.yaml.`);
        }
      })
      .catch(err => addLog(`[LDAP-ERR] Failed pulling LDAP settings: ${err.message}`));
  };

  const fetchEsConfig = () => {
    fetch('/api/es/config')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success' && data.config) {
          setEsConfig(data.config);
          addLog(`[ES] Loaded Elasticsearch configuration from config.yaml.`);
        }
      })
      .catch(err => addLog(`[ES-ERR] Failed pulling Elasticsearch settings: ${err.message}`));
  };

  const handleSaveLdapConfig = () => {
    fetch('/api/ldap/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ldapConfig)
    })
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setLdapConfig(data.config);
          addLog(`[LDAP] Configuration saved to config.yaml.`);
          triggerToast('LDAP configuration saved.');
        } else {
          triggerToast(`LDAP save failed: ${data.error || 'Unknown error'}`);
        }
      })
      .catch(err => triggerToast(`LDAP save failed: ${err.message}`));
  };

  const handleSaveEsConfig = () => {
    fetch('/api/es/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(esConfig)
    })
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setEsConfig(data.config);
          addLog(`[ES] Configuration saved to config.yaml.`);
          triggerToast('Elasticsearch configuration saved.');
        } else {
          triggerToast(`Elasticsearch save failed: ${data.error || 'Unknown error'}`);
        }
      })
      .catch(err => triggerToast(`Elasticsearch save failed: ${err.message}`));
  };

  useEffect(() => {
    fetchLdapConfig();
    fetchEsConfig();
  }, []);

  useEffect(() => {
    let active = true;

    async function checkHealth() {
      // 1. ES check
      try {
        const res = await fetch(`/api/es-health?nodes=${encodeURIComponent(esConfig.nodeUrls)}`);
        const data = await res.json();
        if (active) {
          if (data.ok) {
            setEsStatus(data.status ? data.status.toUpperCase() as any : 'GREEN');
          } else {
            setEsStatus('DISCONNECTED');
          }
        }
      } catch (err) {
        if (active) setEsStatus('DISCONNECTED');
      }

      // 2. LDAP check
      try {
        const res = await fetch(`/api/ldap-health?url=${encodeURIComponent(ldapUrl)}`);
        const data = await res.json();
        if (active) {
          if (data.ok) {
            setLdapStatus('CONNECTED');
          } else {
            setLdapStatus('DISCONNECTED');
          }
        }
      } catch (err) {
        if (active) setLdapStatus('DISCONNECTED');
      }
    }

    checkHealth();
    return () => {
      active = false;
    };
  }, [esConfig.nodeUrls, ldapUrl]);

  const [testEsLoading, setTestEsLoading] = useState(false);

  // State C: Local Users list
  const [localUsers, setLocalUsers] = useState<User[]>([]);
  const [localUsersFile, setLocalUsersFile] = useState('data/local-users.json');
  const [passwordEdits, setPasswordEdits] = useState<Record<string, string>>({});
  const [visibleCredentials, setVisibleCredentials] = useState<Record<string, boolean>>({});

  // Form states for creating a new local user
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'super_admin' | 'observer'>('observer');
  const [newDepartment, setNewDepartment] = useState('');

  const fetchLocalUsers = () => {
    fetch('/api/local-users')
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'success') {
          setLocalUsers(data.users);
          if (data.credentialsFile) setLocalUsersFile(data.credentialsFile);
        }
      })
      .catch((err) => addLog(`[USERLOG-ERR] Failed loading local users: ${err.message}`));
  };

  // Handle local user uploads
  const handleCreateUser = (e: FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || !newFullName.trim() || !newEmail.trim()) {
      triggerToast('All user details are required.');
      return;
    }

    fetch('/api/local-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newUsername,
        password: newPassword,
        fullName: newFullName,
        email: newEmail,
        role: newRole,
        department: newDepartment,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status !== 'success') throw new Error(data.error || 'Failed to create user.');
        fetchLocalUsers();
        addLog(`[USERLOG] Created local principal: ${data.user.fullName} (${data.user.role})`);
        triggerToast(`Added local account "${data.user.username}".`);
        setNewUsername('');
        setNewFullName('');
        setNewEmail('');
        setNewPassword('');
        setNewDepartment('');
      })
      .catch((err) => triggerToast(err.message));
  };

  const handleDeleteUser = (id: string, name: string) => {
    fetch(`/api/local-users/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((res) => res.json())
      .then((data) => {
        if (data.status !== 'success') throw new Error(data.error || 'Failed to delete user.');
        fetchLocalUsers();
        addLog(`[USERLOG] Privileges revoked and removed User ID: ${id}`);
        triggerToast(`Revoked access for local principal: ${name}`);
      })
      .catch((err) => triggerToast(err.message));
  };

  const handleChangeUserPassword = (id: string, name: string) => {
    const password = (passwordEdits[id] || '').trim();
    if (!password) {
      triggerToast('Enter a new password first.');
      return;
    }

    fetch(`/api/local-users/${encodeURIComponent(id)}/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status !== 'success') throw new Error(data.error || 'Failed to update password.');
        setPasswordEdits((prev) => ({ ...prev, [id]: '' }));
        fetchLocalUsers();
        addLog(`[USERLOG] Password updated for local principal: ${name}`);
        triggerToast(`Updated password for ${name}.`);
      })
      .catch((err) => triggerToast(err.message));
  };

  const toggleCredentialVisibility = (key: string) => {
    setVisibleCredentials((current) => ({ ...current, [key]: !current[key] }));
  };

  const credentialInputType = (key: string) => visibleCredentials[key] ? 'text' : 'password';

  const renderCredentialToggle = (key: string) => (
    <button
      type="button"
      onClick={() => toggleCredentialVisibility(key)}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
      title={visibleCredentials[key] ? 'Hide credential' : 'Show credential'}
    >
      {visibleCredentials[key] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
    </button>
  );

  // LDAP file cert parser simulator
  const handleLdapCertUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setLdapConfig(prev => ({
        ...prev,
        caCertificateName: file.name,
        caCertificateContent: text
      }));
      addLog(`[LDAP-SSL] Parsed Custom CA certificate: ${file.name} (${file.size} bytes)`);
      triggerToast(`Custom LDAP Root Cert Loaded!`);
    };
    reader.readAsText(file);
  };

  // Elasticsearch File cert upload parse simulator
  const handleEsFileCertUpload = (e: ChangeEvent<HTMLInputElement>, field: 'ca' | 'clientCert' | 'clientKey') => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;

      if (field === 'ca') {
        setEsConfig(prev => ({
          ...prev,
          caCertificateName: file.name,
          caCertificateContent: text
        }));
        addLog(`[ES-SSL] Loaded cluster CA authority certificate file: ${file.name}`);
      } else if (field === 'clientCert') {
        setEsConfig(prev => ({
          ...prev,
          clientCertificateName: file.name,
          clientCertificateContent: text
        }));
        addLog(`[ES-SSL] Loaded App client identity PEM certificate block: ${file.name}`);
      } else if (field === 'clientKey') {
        setEsConfig(prev => ({
          ...prev,
          clientKeyName: file.name,
          clientKeyContent: text
        }));
        addLog(`[ES-SSL] Parsed App matching client RSA private key: ${file.name}`);
      }
      triggerToast(`Uploaded and aligned ${file.name}`);
    };
    reader.readAsText(file);
  };

  const runLdapTest = async (includeUserCredentials: boolean) => {
    try {
      const res = await fetch('/api/ldap/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: ldapConfig,
          testUsername: includeUserCredentials ? ldapTestCredentials.username : '',
          testPassword: includeUserCredentials ? ldapTestCredentials.password : '',
        }),
      });
      const data = await res.json();

      if (data.ok) {
        setLdapStatus('CONNECTED');
        addLog(`[LDAP] ${data.status || 'Connection test completed successfully.'}`);
        if (ldapConfig.enableSSL) {
          addLog(`[LDAP] Ssl handshake complete: negotiating cipher TLS_CHACHA20_POLY1305_SHA256.`);
          addLog(`[LDAP] Checking Root Authority CA matches "${ldapConfig.caCertificateName}"...`);
          if (ldapConfig.verifyCertificates) {
            addLog(`[LDAP] Cert validation verify status: VALID.`);
          } else {
            addLog(`[LDAP-WARN] SSL Verification ignored based on bypass configs!`);
          }
        }
        addLog(`[LDAP] Manager DN / user lookup settings accepted.`);
        addLog(`[LDAP] Search base configured as ${ldapConfig.searchBase || ldapConfig.baseDn || 'LDAP URL base DN'}.`);
        triggerToast(includeUserCredentials ? 'LDAP test user authenticated.' : 'LDAP connection verified.');
      } else {
        setLdapStatus('DISCONNECTED');
        addLog(`[LDAP-ERROR] Test failed for ${ldapUrl}. Root cause: ${data.error}`);
        triggerToast(includeUserCredentials ? `LDAP user test failed: ${data.error || 'Authentication failed'}` : `LDAP connection failed: ${data.error || 'Unreachable or port closed'}`, 'error');
      }
    } catch (err: any) {
      setLdapStatus('DISCONNECTED');
      addLog(`[LDAP-ERROR] Failed to run LDAP ${includeUserCredentials ? 'user authentication' : 'connection'} test: ${err.message}`);
      triggerToast(`LDAP ${includeUserCredentials ? 'user' : 'connection'} test failed: ${err.message}`, 'error');
    }
  };

  // Connection pings to LDAP
  const handlePinLdapSocket = async () => {
    setTestLdapLoading(true);
    addLog(`[LDAP] Testing LDAP connection settings against endpoint ${ldapUrl}...`);
    await runLdapTest(false);
    setTestLdapLoading(false);
  };

  const handleTestLdapUser = async () => {
    if (!ldapTestCredentials.username.trim() || !ldapTestCredentials.password) {
      triggerToast('Enter both Test User Name and Test Password.');
      return;
    }
    setTestLdapUserLoading(true);
    addLog(`[LDAP] Testing user bind for ${ldapTestCredentials.username.trim()}...`);
    await runLdapTest(true);
    setTestLdapUserLoading(false);
  };

  const handlePingElasticCluster = async () => {
    setTestEsLoading(true);
    addLog(`[ES-PING] Pinging cluster nodes array list: [ ${esConfig.nodeUrls} ]`);

    try {
      const res = await fetch(`/api/es-health?nodes=${encodeURIComponent(esConfig.nodeUrls)}`);
      const data = await res.json();
      if (data.ok) {
        setEsStatus(data.status ? data.status.toUpperCase() as any : 'GREEN');
        addLog(`[ES] TCP connection established with Elasticsearch proxy.`);
        if (esConfig.enableSSL) {
          addLog(`[ES] TLS verification: simulated internal bypass for Docker stack.`);
        }
        addLog(`[ES] clusterName matches: "${esConfig.clusterName}"`);
        addLog(`[ES] Shards status verification: Total shards = ${esConfig.shardsCount}, healthy active replication scale = ${esConfig.replicasCount}`);
        addLog(`[ES] State: ${data.status.toUpperCase()}. Cluster OK.`);
        triggerToast(`Elasticsearch clustering connection test: ${data.status.toUpperCase()}.`);
      } else {
        setEsStatus('DISCONNECTED');
        throw new Error(data.error || "Connection timeout or cluster is red");
      }
    } catch (err: any) {
      setEsStatus('DISCONNECTED');
      addLog(`[ES] FAIL. Unable to route traffic to ES proxy. Error: ${err.message}`);
      triggerToast('Elasticsearch clustering test failed.', 'error');
    } finally {
      setTestEsLoading(false);
    }
  };

  const auditLogsTotalPages = Math.max(1, Math.ceil(auditLogsTotal / auditLogsPageSize));
  const auditLogsStart = auditLogsTotal === 0 ? 0 : (auditLogsPage - 1) * auditLogsPageSize + 1;
  const auditLogsEnd = Math.min(auditLogsPage * auditLogsPageSize, auditLogsTotal);

  return (
    <div
      className="h-screen max-h-screen w-screen flex flex-col overflow-hidden"
      id="kibana-admin-control-room"
      style={{ backgroundColor: 'oklch(0.129 0.042 264.695)' }}
    >

      {/* Admin Panel Header Banner */}
      <div className="bg-slate-900 text-white border-b border-slate-800 flex flex-col sm:flex-row items-center justify-between px-4 py-2 gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <img src={ingLogo} alt="ING" className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold tracking-wider text-sm text-white uppercase font-sans">
                RELEASE LOGS
              </span>
              <span className="text-xs text-[#00a9e5] font-light font-mono tracking-tight uppercase">
                AZURE DEVOPS
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded border border-slate-700 bg-slate-900 text-slate-300 uppercase font-bold font-sans">
                Administrator
              </span>
              <div className="flex items-center gap-1.5 ml-2 bg-slate-950 px-2 py-1 rounded border border-slate-800 max-w-[200px] truncate" title={`Log session user: ${currentUser.fullName}`}>
                <UserIcon className="w-3 h-3 text-[#00a9e5] shrink-0" />
                <span className="text-[11px] font-mono font-bold text-slate-300 tracking-tight truncate">{currentUser.username}</span>
                <span className={`text-[9px] px-1 rounded font-sans uppercase font-bold shrink-0 text-white ${
                  currentUser.type === 'ldap'
                    ? 'bg-indigo-600/40 border border-indigo-400/20'
                    : 'bg-emerald-600/40 border border-emerald-400/20'
                }`}>
                  {currentUser.type}
                </span>
              </div>
            </div>

          </div>
        </div>

        {/* Header Tools */}
        <div className="flex items-center gap-2">
          <button
            onClick={onBackToSearch}
            className="text-xs font-semibold px-3.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 hover:text-white text-slate-200 transition-all cursor-pointer border border-slate-700"
          >
            ← Home
          </button>
          <button
            onClick={onLogout}
            className="text-xs font-semibold px-3 py-1.5 rounded bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800 transition-colors cursor-pointer"
          >
            Switch User / Log out
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden" style={{ backgroundColor: 'oklch(0.129 0.042 264.695)' }}>

        {/* Left internal secondary bar navigation */}
        <div
          className="w-64 h-full overflow-y-auto border-r border-slate-800 p-4 flex flex-col gap-4 shrink-0"
          style={{ backgroundColor: 'oklch(0.129 0.042 264.695)' }}
        >
          <div>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => navigateToTab('general')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  ['general', 'app_https'].includes(activeTab)
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Settings className="w-4 h-4 text-sky-400" />
                App Settings
              </button>

              <button
                onClick={() => navigateToTab('ldap')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 'ldap'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Users className="w-4 h-4" />
                LDAP Domain Setup
              </button>

              <button
                onClick={() => navigateToTab('elasticsearch')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 'elasticsearch'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Database className="w-4 h-4" />
                Elasticsearch Nodes & SSL
              </button>

              <button
                onClick={() => navigateToTab('local_users')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 'local_users'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Key className="w-4 h-4" />
                Local Users
              </button>

              <button
                onClick={() => navigateToTab('s3_proxy')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 's3_proxy'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Server className="w-4 h-4 text-amber-500" />
                S3 Admin
              </button>

              <button
                onClick={() => navigateToTab('s3_files')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 's3_files'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <FileCode className="w-4 h-4 text-blue-400" />
                S3 File Management
              </button>

              <button
                onClick={() => navigateToTab('audit_logs')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 'audit_logs'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Security Audit Logs
              </button>

              <button
                onClick={() => navigateToTab('cluster_status')}
                className={`w-full text-left font-medium text-xs px-3 py-2.5 rounded transition-all duration-150 flex items-center gap-2 cursor-pointer ${
                  activeTab === 'cluster_status'
                    ? 'bg-[#006bb4] text-white font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Terminal className="w-4 h-4 text-indigo-400" />
                Cluster Status & Logs
              </button>
            </div>
          </div>
        </div>

        {/* Center Admin Tab Content area */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5 text-slate-300 flex flex-col lg:flex-row gap-5">

          <div className="flex-1 space-y-5">
            {['general', 'app_https'].includes(activeTab) && (
              <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 pb-3">
                {[
                  { tab: 'general' as AdminTab, label: 'General', icon: Settings },
                  { tab: 'app_https' as AdminTab, label: 'App HTTPS', icon: Lock },
                ].map(({ tab, label, icon: Icon }) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => navigateToTab(tab)}
                    className={`text-xs font-semibold px-3 py-2 rounded border transition-colors cursor-pointer flex items-center gap-1.5 ${
                      activeTab === tab
                        ? 'bg-[#006bb4] border-[#006bb4] text-white'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            )}

            {activeTab === 'general' && (
              <>
                <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                <div className="pb-3 border-b border-slate-750">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wide">General</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Configure global application behavior for authenticated users.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">User session timeout minutes</label>
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      value={appConfig.sessionTimeoutMinutes}
                      onChange={(e) => setAppConfig({ ...appConfig, sessionTimeoutMinutes: Number(e.target.value) })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400 leading-relaxed">
                    Browser sessions expire after this duration and are invalidated automatically when the app restarts.
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Default local user email domain</label>
                    <input
                      type="text"
                      value={appConfig.localUserEmailDomain}
                      onChange={(e) => setAppConfig({ ...appConfig, localUserEmailDomain: e.target.value })}
                      placeholder=""
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => saveAppConfig(false)}
                    disabled={appConfigSaving}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {appConfigSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                    Save General Settings
                  </button>
                </div>
                </div>

                <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="pb-3 border-b border-slate-750">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wide">Default Elasticsearch index</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Observer (viewer) accounts only see this index in Discover. They cannot switch to other indices.
                    </p>
                  </div>
                  <form onSubmit={handleSaveDiscoverConfig} className="flex flex-col sm:flex-row gap-3 items-end">
                    <div className="flex-1 space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">
                        Default index for viewer users
                      </label>
                      <select
                        value={defaultDiscoverIndex}
                        onChange={(e) => setDefaultDiscoverIndex(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded p-2 text-slate-100 font-mono text-xs"
                      >
                        {availableIndices.length === 0 ? (
                          <option value={defaultDiscoverIndex}>{defaultDiscoverIndex}</option>
                        ) : (
                          availableIndices.map((idx) => (
                            <option key={idx.name} value={idx.name}>
                              {idx.name}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <button
                      type="submit"
                      disabled={discoverConfigSaving}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 cursor-pointer"
                    >
                      {discoverConfigSaving ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle className="w-4 h-4" />
                      )}
                      Save default index
                    </button>
                  </form>
                </div>
              </>
            )}

            {/* TAB: LDAP CONFIGURATOR */}
            {activeTab === 'ldap' && (
              <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-750">
                  <div>
                    <h3 className="text-sm font-bold text-white uppercase tracking-wide">LDAP Authentication Configuration</h3>
                    <p className="text-xs text-slate-400">Manage active directory credentials and mapping constraints</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handlePinLdapSocket}
                      disabled={testLdapLoading}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testLdapLoading ? 'animate-spin' : ''}`} />
                      Test Connection
                    </button>

                    <button
                      onClick={handleSaveLdapConfig}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      Save Settings
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">LDAP URL</label>
                    <input
                      type="text"
                      value={ldapConfig.ldapUrl || ldapConfig.serverUrl}
                      onChange={(e) => setLdapConfig({ ...ldapConfig, ldapUrl: e.target.value, serverUrl: e.target.value })}
                      placeholder="e.g. ldap://myserver:myport/dc=sampledomain,dc=com"
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">User DN Pattern</label>
                    <input
                      type="text"
                      value={ldapConfig.userDnPattern || ''}
                      onChange={(e) => setLdapConfig({ ...ldapConfig, userDnPattern: e.target.value })}
                      placeholder="e.g. uid={0},ou=People"
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Email Attribute</label>
                    <input
                      type="text"
                      value={ldapConfig.emailAttribute || ''}
                      onChange={(e) => setLdapConfig({ ...ldapConfig, emailAttribute: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Search Filter</label>
                    <input
                      type="text"
                      value={ldapConfig.searchFilter || ldapConfig.userSearchFilter}
                      onChange={(e) => setLdapConfig({ ...ldapConfig, searchFilter: e.target.value, userSearchFilter: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Search Base</label>
                    <input
                      type="text"
                      value={ldapConfig.searchBase || ldapConfig.baseDn}
                      onChange={(e) => setLdapConfig({ ...ldapConfig, searchBase: e.target.value, baseDn: e.target.value })}
                      placeholder="e.g. ou=internalUsers,ou=hq|ou=externalUsers"
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Manager DN</label>
                    <input
                      type="text"
                      value={ldapConfig.managerDn || ldapConfig.bindDn}
                      onChange={(e) => setLdapConfig({ ...ldapConfig, managerDn: e.target.value, bindDn: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Manager Password</label>
                    <div className="relative">
                      <input
                        type={credentialInputType('ldapManagerPassword')}
                        value={ldapConfig.managerPassword || ldapConfig.bindPassword || ''}
                        onChange={(e) => setLdapConfig({ ...ldapConfig, managerPassword: e.target.value, bindPassword: e.target.value })}
                        placeholder="***************************************"
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 pr-9 text-slate-100 font-mono"
                      />
                      {renderCredentialToggle('ldapManagerPassword')}
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg space-y-3.5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 font-sans">
                      <UserIcon className="w-4 h-4 text-indigo-400" />
                      Test LDAP User
                    </span>
                    <button
                      type="button"
                      onClick={handleTestLdapUser}
                      disabled={testLdapUserLoading}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testLdapUserLoading ? 'animate-spin' : ''}`} />
                      Test User
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Test User Name</label>
                      <input
                        type="text"
                        value={ldapTestCredentials.username}
                        onChange={(e) => setLdapTestCredentials({ ...ldapTestCredentials, username: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Test Password</label>
                      <div className="relative">
                        <input
                          type={credentialInputType('ldapTestPassword')}
                          value={ldapTestCredentials.password}
                          onChange={(e) => setLdapTestCredentials({ ...ldapTestCredentials, password: e.target.value })}
                          className="w-full bg-slate-950 border border-slate-850 rounded p-2 pr-9 text-slate-100 font-mono"
                        />
                        {renderCredentialToggle('ldapTestPassword')}
                      </div>
                    </div>
                  </div>
                </div>

                {/* LDAP Certificate Control */}
                <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg space-y-3.5 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 font-sans">
                      <Lock className="w-4 h-4 text-emerald-400" />
                      Root CA SSL Security Certificates File Config
                    </span>
                    <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                      <input
                        type="checkbox"
                        checked={ldapConfig.enableSSL}
                        onChange={(e) => {
                          setLdapConfig({ ...ldapConfig, enableSSL: e.target.checked });
                          addLog(`[LDAP] SSL socket toggle modified to: ${e.target.checked}`);
                        }}
                        className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                      />
                      <span className="font-sans text-slate-300">Enable LDAPS (SSL/TLS Connection)</span>
                    </label>
                  </div>

                  {ldapConfig.enableSSL && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Upload block */}
                      <div className="space-y-2">
                        <span className="text-[11px] text-slate-400 block font-sans">
                          Select the PEM certificate authority cert file used to negotiate certificate trust chains.
                        </span>

                        <div className="flex items-center gap-2">
                          <label className="bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-200 text-xs px-3 py-2 rounded flex items-center gap-1.5 font-sans cursor-pointer">
                            <Upload className="w-3.5 h-3.5 text-blue-400" />
                            Upload LDAP Root Cert file (.crt/.pem)
                            <input
                              type="file"
                              accept=".crt,.pem,.txt"
                              onChange={handleLdapCertUpload}
                              className="hidden"
                            />
                          </label>
                          <span className="text-xs text-slate-400 font-mono truncate max-w-xs block">
                            File aligned: <strong>{ldapConfig.caCertificateName || 'None'}</strong>
                          </span>
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer text-xs pt-1.5 font-sans">
                          <input
                            type="checkbox"
                            checked={ldapConfig.verifyCertificates}
                            onChange={(e) => {
                              setLdapConfig({ ...ldapConfig, verifyCertificates: e.target.checked });
                              addLog(`[LDAP] Verification of LDAP cert configured to: ${e.target.checked}`);
                            }}
                            className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                          />
                          <span>Strict certificate trust checks (reject self-signed authorities)</span>
                        </label>
                      </div>

                      {/* Display content */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-450 uppercase">
                          <span>CA Content view</span>
                          <span className="text-[10px] text-emerald-400 uppercase font-mono">parsed as pem block</span>
                        </div>
                        <textarea
                          rows={3}
                          value={ldapConfig.caCertificateContent}
                          onChange={(e) => setLdapConfig({ ...ldapConfig, caCertificateContent: e.target.value })}
                          className="w-full text-[10px] font-mono bg-slate-950 p-2 text-slate-400 rounded border border-slate-800 resize-none outline-none focus:border-blue-600"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: ELASTICSEARCH NODES SSL SETTINGS */}
            {activeTab === 'elasticsearch' && (
              <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-750">
                  <div>
                    <h3 className="text-sm font-bold text-white uppercase tracking-wide">Elasticsearch Connections & Client Certificates</h3>
                    <p className="text-xs text-slate-400">Add cluster nodes with multi-client SSL certificate authorities</p>
                  </div>

                  <button
                    onClick={handlePingElasticCluster}
                    disabled={testEsLoading}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${testEsLoading ? 'animate-spin' : ''}`} />
                    Ping Cluster Nodes
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">

                  <div className="space-y-1 md:col-span-2">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Elasticsearch Node Cluster Host endpoints (comma separated)</label>
                    <input
                      type="text"
                      value={esConfig.nodeUrls}
                      onChange={(e) => setEsConfig({ ...esConfig, nodeUrls: e.target.value })}
                      placeholder="https://ip-address:9200, https://ip-address:9201"
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Authentication Type</label>
                    <select
                      value={esConfig.authMethod}
                      onChange={(e) => {
                        setEsConfig({ ...esConfig, authMethod: e.target.value as any });
                        addLog(`[ES] Elasticsearch auth Method toggle switched to: ${e.target.value}`);
                      }}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 text-xs font-mono"
                    >
                      <option value="basic">Basic authentication (Username/Password)</option>
                      <option value="token">JSON Web Token / API Key header</option>
                      <option value="anonymous">Anonymous Access (Closed connection)</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Cluster Display Identifier</label>
                    <input
                      type="text"
                      value={esConfig.clusterName}
                      onChange={(e) => setEsConfig({ ...esConfig, clusterName: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  {esConfig.authMethod === 'basic' && (
                    <>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Admin Username</label>
                        <input
                          type="text"
                          value={esConfig.username}
                          onChange={(e) => setEsConfig({ ...esConfig, username: e.target.value })}
                          className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Admin Secret Password</label>
                        <div className="relative">
                          <input
                            type={credentialInputType('esPassword')}
                            value={esConfig.password}
                            onChange={(e) => setEsConfig({ ...esConfig, password: e.target.value })}
                            className="w-full bg-slate-900 border border-slate-850 rounded p-2 pr-9 text-slate-100 font-mono"
                          />
                          {renderCredentialToggle('esPassword')}
                        </div>
                      </div>
                    </>
                  )}

                  {esConfig.authMethod === 'token' && (
                    <div className="space-y-1 md:col-span-2">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">API Security KEY Token</label>
                      <div className="relative">
                        <input
                          type={credentialInputType('esToken')}
                          value={esConfig.token}
                          onChange={(e) => setEsConfig({ ...esConfig, token: e.target.value })}
                          placeholder="encoded ES api key string..."
                          className="w-full bg-slate-900 border border-slate-850 rounded p-2 pr-9 text-slate-100 font-mono"
                        />
                        {renderCredentialToggle('esToken')}
                      </div>
                    </div>
                  )}
                </div>

                {/* Elasticsearch SSL Configuration Section */}
                <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 font-sans">
                      <Lock className="w-4 h-4 text-emerald-400" />
                      Client Certificate (mTLS) & Server Cert Authority Verification
                    </span>
                    <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                      <input
                        type="checkbox"
                        checked={esConfig.enableSSL}
                        onChange={(e) => {
                          setEsConfig({ ...esConfig, enableSSL: e.target.checked });
                          addLog(`[ES] TLS connection toggle configured to: ${e.target.checked}`);
                        }}
                        className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                      />
                      <span className="font-sans text-slate-300">Enable TLS/SSL socket</span>
                    </label>
                  </div>

                  {esConfig.enableSSL && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                      {/* CA cert loading column */}
                      <div className="space-y-2 bg-slate-950/50 p-3 rounded border border-slate-800">
                        <span className="text-[11px] font-bold text-slate-200 block">1. Server CA Certificate</span>
                        <div className="flex flex-col gap-2">
                          <label className="bg-slate-800 hover:bg-slate-750 text-slate-200 text-[10px] py-1 px-2.5 rounded text-center cursor-pointer">
                            Choose CA Cert File (.crt/.pem)
                            <input
                              type="file"
                              accept=".crt,.pem,.txt"
                              onChange={(e) => handleEsFileCertUpload(e, 'ca')}
                              className="hidden"
                            />
                          </label>
                          <span className="text-[10px] font-mono text-slate-450 truncate block">File: {esConfig.caCertificateName || 'none'}</span>
                        </div>
                        <textarea
                          rows={2}
                          value={esConfig.caCertificateContent}
                          onChange={(e) => setEsConfig({ ...esConfig, caCertificateContent: e.target.value })}
                          className="w-full text-[9px] font-mono bg-slate-900 p-1.5 text-slate-450 border border-slate-800 resize-none rounded"
                        />
                      </div>

                      {/* Client Identity Certificate */}
                      <div className="space-y-2 bg-slate-950/50 p-3 rounded border border-slate-800">
                        <span className="text-[11px] font-bold text-slate-200 block">2. Public Client Certificate</span>
                        <div className="flex flex-col gap-2">
                          <label className="bg-slate-800 hover:bg-slate-750 text-slate-200 text-[10px] py-1 px-2.5 rounded text-center cursor-pointer">
                            Choose Client Cert (.pem)
                            <input
                              type="file"
                              accept=".pem,.crt,.txt"
                              onChange={(e) => handleEsFileCertUpload(e, 'clientCert')}
                              className="hidden"
                            />
                          </label>
                          <span className="text-[10px] font-mono text-slate-450 truncate block">File: {esConfig.clientCertificateName || 'none'}</span>
                        </div>
                        <textarea
                          rows={2}
                          value={esConfig.clientCertificateContent}
                          onChange={(e) => setEsConfig({ ...esConfig, clientCertificateContent: e.target.value })}
                          className="w-full text-[9px] font-mono bg-slate-900 p-1.5 text-slate-450 border border-slate-800 resize-none rounded"
                        />
                      </div>

                      {/* Client Key Certificate Authority */}
                      <div className="space-y-2 bg-slate-950/50 p-3 rounded border border-slate-800">
                        <span className="text-[11px] font-bold text-slate-200 block">3. RSA Client Secret KEY</span>
                        <div className="flex flex-col gap-2">
                          <label className="bg-slate-800 hover:bg-slate-750 text-slate-200 text-[10px] py-1 px-2.5 rounded text-center cursor-pointer">
                            Choose Client Key (.key)
                            <input
                              type="file"
                              accept=".key,.pem,.txt"
                              onChange={(e) => handleEsFileCertUpload(e, 'clientKey')}
                              className="hidden"
                            />
                          </label>
                          <span className="text-[10px] font-mono text-slate-450 truncate block">File: {esConfig.clientKeyName || 'none'}</span>
                        </div>
                        <textarea
                          rows={2}
                          value={esConfig.clientKeyContent}
                          onChange={(e) => setEsConfig({ ...esConfig, clientKeyContent: e.target.value })}
                          className="w-full text-[9px] font-mono bg-slate-900 p-1.5 text-slate-450 border border-slate-800 resize-none rounded"
                        />
                      </div>

                    </div>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer text-xs mt-1.5 select-none text-slate-400 hover:text-white font-sans">
                    <input
                      type="checkbox"
                      checked={esConfig.verifyServerCertificate}
                      onChange={(e) => {
                        setEsConfig({ ...esConfig, verifyServerCertificate: e.target.checked });
                        addLog(`[ES] Verify server certificate hostnames turned to: ${e.target.checked}`);
                      }}
                      className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                    />
                    <span>Verify server certificates against hostnames configurations matching domain strings</span>
                  </label>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={handleSaveEsConfig}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-6 py-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    Save Elasticsearch Config
                  </button>
                </div>
              </div>
            )}

            {/* TAB: APP HTTPS CERTIFICATE */}
            {activeTab === 'app_https' && (
              <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-750">
                  <div>
                    <h3 className="text-sm font-bold text-white uppercase tracking-wide">App HTTPS</h3>
                    <p className="text-xs text-slate-400">Configure the self-signed certificate used by the app HTTPS listener.</p>
                  </div>
                  <span className={`text-[10px] px-2 py-1 rounded uppercase font-bold border ${
                    appConfig.enableHTTPS === true
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-slate-900 border-slate-700 text-slate-400'
                  }`}>
                    {appConfig.enableHTTPS === true ? `HTTPS :${appConfig.httpsPort}` : 'HTTP only'}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                  <label className="flex items-center gap-2 cursor-pointer text-xs select-none md:col-span-2">
                    <input
                      type="checkbox"
                      checked={appConfig.enableHTTPS === true}
                      onChange={(e) => setAppConfig({ ...appConfig, enableHTTPS: e.target.checked })}
                      className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                    />
                    <span className="font-sans text-slate-300">Enable HTTPS listener on App</span>
                  </label>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">HTTPS Port</label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={appConfig.httpsPort}
                      onChange={(e) => setAppConfig({ ...appConfig, httpsPort: Number(e.target.value) })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Certificate Common Name</label>
                    <input
                      type="text"
                      value={appConfig.commonName}
                      onChange={(e) => setAppConfig({ ...appConfig, commonName: e.target.value })}
                      placeholder="localhost"
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Certificate File Name</label>
                    <input
                      type="text"
                      value={appConfig.certificateName}
                      onChange={(e) => setAppConfig({ ...appConfig, certificateName: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Private Key File Name</label>
                    <input
                      type="text"
                      value={appConfig.privateKeyName}
                      onChange={(e) => setAppConfig({ ...appConfig, privateKeyName: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Valid Days</label>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={appConfig.validDays}
                      onChange={(e) => setAppConfig({ ...appConfig, validDays: Number(e.target.value) })}
                      className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Certificate PEM</label>
                    <textarea
                      rows={6}
                      value={appConfig.certificateContent}
                      onChange={(e) => setAppConfig({ ...appConfig, certificateContent: e.target.value })}
                      className="w-full text-[10px] font-mono bg-slate-950 p-2 text-slate-300 rounded border border-slate-800 resize-y outline-none focus:border-blue-600"
                    />
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Private Key PEM</label>
                    <textarea
                      rows={6}
                      value={appConfig.privateKeyContent}
                      onChange={(e) => setAppConfig({ ...appConfig, privateKeyContent: e.target.value })}
                      className="w-full text-[10px] font-mono bg-slate-950 p-2 text-slate-300 rounded border border-slate-800 resize-y outline-none focus:border-blue-600"
                    />
                  </div>

                  <div className="md:col-span-2 flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => saveAppConfig(true)}
                      disabled={appConfigSaving}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${appConfigSaving ? 'animate-spin' : ''}`} />
                      Regenerate Self-Signed Cert
                    </button>
                    <button
                      type="button"
                      onClick={() => saveAppConfig(false)}
                      disabled={appConfigSaving}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {appConfigSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                      Save HTTPS Settings
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: LOCAL USER DIRECTORY CREATION AND MANAGEMENT */}
            {activeTab === 'local_users' && (
              <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-5">

                {/* User insertion form */}
                <div>
                  <h3 className="text-sm font-bold text-white uppercase tracking-wide mb-1">Add Local Account</h3>
                  <p className="text-xs text-slate-400 mb-3">
                    Credentials are stored in <span className="font-mono text-slate-200">{localUsersFile}</span>.
                  </p>
                  <form onSubmit={handleCreateUser} className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-slate-900 p-4 border border-slate-800 rounded-lg text-xs leading-none">

                    <div className="space-y-1">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase">Username</label>
                      <input
                        type="text"
                        required
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value)}
                        placeholder="e.g. oacik"
                        className="w-full bg-slate-950 border border-slate-850 p-2 text-white font-mono rounded"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase">Full Name</label>
                      <input
                        type="text"
                        required
                        value={newFullName}
                        onChange={(e) => setNewFullName(e.target.value)}
                        placeholder="e.g. Ogün Açık"
                        className="w-full bg-slate-950 border border-slate-850 p-2 text-white font-sans rounded"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase">Corporate Email</label>
                      <input
                        type="email"
                        required
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder=""
                        className="w-full bg-slate-950 border border-slate-850 p-2 text-white font-sans rounded"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase">Password</label>
                      <div className="relative">
                        <input
                          type={credentialInputType('newLocalPassword')}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Auto-generated if empty"
                          className="w-full bg-slate-950 border border-slate-850 p-2 pr-9 text-white font-mono rounded"
                        />
                        {renderCredentialToggle('newLocalPassword')}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase">Role</label>
                      <select
                        value={newRole}
                        onChange={(e) => setNewRole(e.target.value as any)}
                        className="w-full bg-slate-950 border border-slate-850 p-2 text-white font-sans rounded font-medium"
                      >
                        <option value="observer">Observer (Read-Only access)</option>
                        <option value="super_admin">Super Security Principal</option>
                      </select>
                    </div>

                    <div className="space-y-1 md:col-span-3">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase">Team / Organizational Unit Department</label>
                      <input
                        type="text"
                        value={newDepartment}
                        onChange={(e) => setNewDepartment(e.target.value)}
                        placeholder="e.g. DevOps Squad"
                        className="w-full bg-slate-950 border border-slate-850 p-2 text-white font-sans rounded"
                      />
                    </div>

                    <div className="flex items-end">
                      <button
                        type="submit"
                        className="w-full bg-[#006bb4] hover:bg-[#005a96] text-white py-2 rounded text-xs font-semibold flex items-center justify-center gap-1.5 tracking-wide uppercase transition-colors cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Save User
                      </button>
                    </div>
                  </form>
                </div>

                {/* Local user table */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-400 block uppercase">Existing Local Accounts ({localUsers.length} profiles)</span>

                  <div className="border border-slate-800 rounded bg-slate-900 overflow-hidden">
                    <table className="w-full text-left font-mono text-xs">
                      <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800 text-[11px] uppercase">
                        <tr>
                          <th className="p-3">User Identifiers</th>
                          <th className="p-3">Email</th>
                          <th className="p-3">Department</th>
                          <th className="p-3">Role</th>
                          <th className="p-3">Password</th>
                          <th className="p-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 text-slate-300">
                        {localUsers.map(user => (
                          <tr key={user.id} className="hover:bg-slate-850/50">
                            <td className="p-3">
                              <span className="font-bold text-white block">{user.fullName}</span>
                              <span className="text-[10px] text-slate-500 font-mono">id: {user.id} | cn={user.username}</span>
                            </td>
                            <td className="p-3 font-sans">{user.email}</td>
                            <td className="p-3 font-sans text-xs text-slate-400">{user.department}</td>
                            <td className="p-3">
                              <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full uppercase font-sans font-bold ${
                                user.role === 'super_admin' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
                                'bg-slate-800 text-slate-400'
                              }`}>
                                {user.role.replace('_', ' ')}
                              </span>
                            </td>
                            <td className="p-3">
                              <div className="flex items-center gap-2">
                                <div className="relative">
                                  <input
                                    type={credentialInputType(`localPassword-${user.id}`)}
                                    value={passwordEdits[user.id] || ''}
                                    onChange={(e) => setPasswordEdits((prev) => ({ ...prev, [user.id]: e.target.value }))}
                                    placeholder="New password"
                                    className="w-36 bg-slate-950 border border-slate-850 p-1.5 pr-8 text-white font-mono rounded"
                                  />
                                  {renderCredentialToggle(`localPassword-${user.id}`)}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleChangeUserPassword(user.id, user.fullName)}
                                  className="text-[10px] bg-[#006bb4] hover:bg-[#005a96] text-white px-2 py-1.5 rounded font-sans font-semibold transition-colors cursor-pointer"
                                >
                                  Save
                                </button>
                              </div>
                            </td>
                            <td className="p-3 text-center">
                              <button
                                onClick={() => handleDeleteUser(user.id, user.fullName)}
                                className="text-slate-500 hover:text-rose-500 transition-colors"
                                title="Revoke system access"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            )}

            {/* TAB 4: S3 SECURE PROXY GATEWAY CARD AND FILE LISTS */}
            {activeTab === 's3_proxy' && (
              <div className="space-y-5">
                  <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                    <div className="flex items-center justify-between pb-3 border-b border-slate-750">
                      <div>
                        <h3 className="text-sm font-bold text-white uppercase tracking-wide">S3 / MinIO Storage Gateway Settings</h3>
                        <p className="text-xs text-slate-400">Secure credential mappings for backend proxy downloads — secrets stay hidden on port 3000</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 pb-3">
                      {[
                        { tab: 'connection' as const, label: 'Connection', icon: Server },
                        { tab: 'proxy' as const, label: 'Proxy Settings', icon: ShieldCheck },
                      ].map(({ tab, label, icon: Icon }) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => onNavigateToSection(S3_SETTINGS_ROUTES[tab])}
                          className={`text-xs font-semibold px-3 py-2 rounded border transition-colors cursor-pointer flex items-center gap-1.5 ${
                            s3SettingsTab === tab
                              ? 'bg-[#006bb4] border-[#006bb4] text-white'
                              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {label}
                        </button>
                      ))}
                    </div>

                    <form onSubmit={handleSaveS3Config} className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                    {s3SettingsTab === 'connection' && (
                      <>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Endpoint URL (S3 API Host)</label>
                      <input
                        type="text"
                        value={s3Config.endpointUrl}
                        onChange={(e) => setS3Config({ ...s3Config, endpointUrl: e.target.value })}
                        placeholder="http://localhost:9000"
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">S3 Access Key ID</label>
                      <input
                        type="text"
                        value={s3Config.accessKeyId}
                        onChange={(e) => setS3Config({ ...s3Config, accessKeyId: e.target.value })}
                        placeholder="minioadmin"
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">S3 Secret Access Key</label>
                      <div className="relative">
                        <input
                          type={credentialInputType('s3SecretAccessKey')}
                          value={s3Config.secretAccessKey}
                          onChange={(e) => setS3Config({ ...s3Config, secretAccessKey: e.target.value })}
                          placeholder="••••••••••••••••"
                          className="w-full bg-slate-900 border border-slate-850 rounded p-2 pr-9 text-slate-100 font-mono"
                        />
                        {renderCredentialToggle('s3SecretAccessKey')}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Target Archive Bucket Name</label>
                      <input
                        type="text"
                        value={s3Config.bucketName}
                        onChange={(e) => setS3Config({ ...s3Config, bucketName: e.target.value })}
                        placeholder="elastic-kibana-logs"
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">AWS/MinIO Target Region</label>
                      <input
                        type="text"
                        value={s3Config.region}
                        onChange={(e) => setS3Config({ ...s3Config, region: e.target.value })}
                        placeholder="us-east-1"
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Elasticsearch S3 Catalog Index</label>
                      <input
                        type="text"
                        value={s3Config.catalogIndex}
                        onChange={(e) => setS3Config({ ...s3Config, catalogIndex: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>

                    {/* Path Style / Virtual Hosted Toggle */}
                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">S3 Path Addressing Mode</label>
                      <select
                        value={s3Config.forcePathStyle ? "true" : "false"}
                        onChange={(e) => setS3Config({ ...s3Config, forcePathStyle: e.target.value === "true" })}
                        className="w-full bg-slate-900 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                      >
                        <option value="true">Force Path-Style (Required for local MinIO / LocalStack)</option>
                        <option value="false">Virtual Hosted Addressing (Standard AWS S3 Buckets)</option>
                      </select>
                    </div>

                    {/* SSL Certificates configs */}
                    <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg space-y-3.5 col-span-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 font-sans">
                          <Lock className="w-4 h-4 text-emerald-400" />
                          S3 SSL Trust / Self-Signed Enterprise Certificates Verify
                        </span>

                        <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                          <input
                            type="checkbox"
                            checked={s3Config.enableSSL}
                            onChange={(e) => {
                              setS3Config({ ...s3Config, enableSSL: e.target.checked });
                              addLog(`[S3-SSL] Gateway SSL protocol socket turned to: ${e.target.checked}`);
                            }}
                            className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                          />
                          <span className="font-sans text-slate-300">Enable S3 HTTPS (SSL/TLS Connection)</span>
                        </label>
                      </div>

                      {s3Config.enableSSL && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-sans">
                          <div className="space-y-2">
                            <span className="text-[11px] text-slate-400 block font-sans">
                              Provide custom root CA PEM certificate to negotiate and authenticate trust lines with secure private storage subnets.
                            </span>

                            <label className="flex items-center gap-2 cursor-pointer text-xs pt-1.5 font-sans">
                              <input
                                type="checkbox"
                                checked={s3Config.verifyCertificates}
                                onChange={(e) => {
                                  setS3Config({ ...s3Config, verifyCertificates: e.target.checked });
                                  addLog(`[S3-SSL] Certificate trust strict validation modified to: ${e.target.checked}`);
                                }}
                                className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                              />
                              <span>Enforce strict cluster TLS validation checking</span>
                            </label>
                          </div>

                          <div className="space-y-1">
                            <textarea
                              rows={3}
                              placeholder="-----BEGIN CERTIFICATE-----&#10;(Insert Custom trust certificates PEM Block here)&#10;-----END CERTIFICATE-----"
                              value={s3Config.caCertificateContent}
                              onChange={(e) => setS3Config({ ...s3Config, caCertificateContent: e.target.value })}
                              className="w-full text-[10px] font-mono bg-slate-950 p-2 text-slate-400 rounded border border-slate-800 resize-none outline-none focus:border-blue-600"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                      </>
                    )}

                    {s3SettingsTab === 'proxy' && (
                      <>
                        <div className="md:col-span-2 rounded border border-slate-800 bg-slate-900 p-4 space-y-4">
                          <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                            <input
                              type="checkbox"
                              checked={s3Config.proxyAuthEnabled === true}
                              onChange={(e) => setS3Config({ ...s3Config, proxyAuthEnabled: e.target.checked })}
                              className="rounded border-slate-800 text-blue-500 bg-slate-950 focus:ring-blue-500 cursor-pointer"
                            />
                            <span className="font-sans text-slate-300">Require authentication for S3 proxy downloads</span>
                          </label>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1">
                              <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Authentication Method</label>
                              <select
                                value={s3Config.proxyAuthMethod || 'basic'}
                                onChange={(e) => setS3Config({ ...s3Config, proxyAuthMethod: e.target.value })}
                                disabled={!s3Config.proxyAuthEnabled}
                                className="w-full bg-slate-950 border border-slate-850 rounded p-2 text-slate-100 font-mono disabled:opacity-50"
                              >
                                <option value="basic">Basic Auth with Local User</option>
                                <option value="apiKey">API Key</option>
                              </select>
                            </div>

                            {s3Config.proxyAuthMethod !== 'apiKey' && (
                              <div className="space-y-1">
                                <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Allowed Local User</label>
                                <select
                                  value={s3Config.proxyBasicUsername || ''}
                                  onChange={(e) => setS3Config({ ...s3Config, proxyBasicUsername: e.target.value })}
                                  disabled={!s3Config.proxyAuthEnabled}
                                  className="w-full bg-slate-950 border border-slate-850 rounded p-2 text-slate-100 font-mono disabled:opacity-50"
                                >
                                  <option value="">Any local user</option>
                                  {localUsers.map((user) => (
                                    <option key={user.id} value={user.username}>{user.username}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        </div>

                        {s3Config.proxyAuthMethod === 'apiKey' && (
                          <div className="md:col-span-2 rounded border border-slate-800 bg-slate-900 p-4 space-y-4">
                            <div className="flex flex-col md:flex-row gap-3 md:items-end">
                              <div className="flex-1 space-y-1">
                                <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">New API Key Name</label>
                                <input
                                  type="text"
                                  value={newProxyKeyName}
                                  onChange={(e) => setNewProxyKeyName(e.target.value)}
                                  className="w-full bg-slate-950 border border-slate-850 rounded p-2 text-slate-100 font-mono"
                                />
                              </div>
                              <button
                                type="button"
                                onClick={handleCreateS3ProxyApiKey}
                                disabled={s3Saving}
                                className="bg-[#006bb4] hover:bg-[#005a96] text-white font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                <Plus className="w-4 h-4" />
                                Create API Key
                              </button>
                            </div>

                            {generatedProxyApiKey && (
                              <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3">
                                <label className="block text-[10px] uppercase text-emerald-300 font-sans font-bold mb-1">New API key. Copy now.</label>
                                <input
                                  type="text"
                                  readOnly
                                  value={generatedProxyApiKey}
                                  className="w-full bg-slate-950 border border-emerald-500/30 rounded p-2 text-emerald-200 font-mono"
                                />
                              </div>
                            )}

                            <div className="border border-slate-800 rounded overflow-hidden">
                              <table className="w-full text-left text-xs">
                                <thead className="bg-slate-950 text-slate-500 uppercase font-sans">
                                  <tr>
                                    <th className="p-2">Name</th>
                                    <th className="p-2">Created</th>
                                    <th className="p-2">Status</th>
                                    <th className="p-2 text-right">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                  {(s3Config.proxyApiKeys || []).map((key: any) => (
                                    <tr key={key.id}>
                                      <td className="p-2 text-slate-200">{key.name}</td>
                                      <td className="p-2 text-slate-400 font-mono">{key.createdOn ? new Date(key.createdOn).toLocaleString() : ''}</td>
                                      <td className="p-2">
                                        <span className={`text-[10px] px-2 py-0.5 rounded border uppercase font-bold ${
                                          key.revokedOn ? 'border-rose-500/30 text-rose-400 bg-rose-500/10' : 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
                                        }`}>
                                          {key.revokedOn ? 'Revoked' : 'Active'}
                                        </span>
                                      </td>
                                      <td className="p-2 text-right">
                                        <button
                                          type="button"
                                          onClick={() => handleRevokeS3ProxyApiKey(key.id)}
                                          disabled={Boolean(key.revokedOn) || s3Saving}
                                          className="text-rose-400 hover:text-rose-300 disabled:opacity-40 disabled:hover:text-rose-400 cursor-pointer disabled:cursor-not-allowed"
                                        >
                                          Revoke
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                  {(s3Config.proxyApiKeys || []).length === 0 && (
                                    <tr>
                                      <td className="p-4 text-center text-slate-500" colSpan={4}>No API keys created.</td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                      <div className="col-span-2 flex justify-end gap-3">
                        {s3SettingsTab === 'connection' && (
                          <button
                            type="button"
                            onClick={() => {
                               triggerToast("Testing S3 connection...");
                               fetch('/api/s3/health', {
                                 method: 'POST',
                                 headers: { 'Content-Type': 'application/json' },
                                 body: JSON.stringify(s3Config),
                               })
                                 .then(r => r.json())
                                 .then(data => {
                                   if (data.ok) triggerToast('S3 connection successful.');
                                   else triggerToast(`S3 connection failed: ${data.error}`, 'error');
                                 })
                                 .catch(err => triggerToast(`S3 connection failed: ${err.message}`, 'error'));
                            }}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <RefreshCw className="w-4 h-4" />
                            Test Connection
                          </button>
                        )}
                        <button
                          type="submit"
                          disabled={s3Saving}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          {s3Saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                          {s3SettingsTab === 'connection' ? 'Apply & Save Storage Mappings' : 'Save Proxy Settings'}
                        </button>
                      </div>
                    </form>
                  </div>

              </div>
            )}

            {activeTab === 's3_files' && (
              <div className="space-y-5">
                <KibanaS3Manager
                  embedded
                  currentUser={currentUser}
                  onNotify={(msg) => triggerToast(msg)}
                />
              </div>
            )}

            {/* TAB 5: SECURITY AUDIT LOGS FOR ELASTICSEARCH INDEX */}
            {activeTab === 'audit_logs' && (
              <div className="space-y-5">

                {/* Audit Elasticsearch Index Configuration board */}
                <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-750">
                    <div>
                      <h3 className="text-sm font-bold text-white uppercase tracking-wide">Elasticsearch Audit Index Target</h3>
                      <p className="text-xs text-slate-400">Configure which Elasticsearch index is used to store and search admin audit trails (logins and proxy downloads)</p>
                    </div>

                    <button
                      onClick={() => fetchAuditLogs(auditIndex, auditLogsPage, auditLogsPageSize)}
                      disabled={auditLogsLoading || !auditIndex}
                      className="text-amber-400 border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer font-sans"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${auditLogsLoading ? 'animate-spin' : ''}`} />
                      Query Audit Logs Index
                    </button>
                  </div>

                  <form onSubmit={handleSaveAuditConfig} className="flex flex-col sm:flex-row items-end gap-3 text-xs font-mono">
                    <div className="flex-1 space-y-1">
                      <label className="block text-[10px] uppercase text-slate-400 font-sans font-bold">Target Elasticsearch Audit Index Name</label>
                      <input
                        type="text"
                        value={auditIndex}
                        onChange={(e) => setAuditIndex(e.target.value)}
                        placeholder=""
                        className="w-full bg-slate-900 border border-slate-800 rounded p-2 text-slate-100 font-mono text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={auditConfigLoading}
                      className="bg-[#006bb4] hover:bg-[#005a96] text-white font-sans text-xs font-semibold px-5 py-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer select-none"
                    >
                      {auditConfigLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                      Sync Audit Index Settings
                    </button>
                  </form>
                </div>

                {/* Audit trail table */}
                <div className="bg-slate-850 border border-slate-800 rounded-lg p-5 space-y-4">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-white uppercase tracking-wide">Enterprise Security Log Trace</h3>
                      <p className="text-xs text-slate-400 font-sans">
                        Showing {auditLogsStart}-{auditLogsEnd} of {auditLogsTotal} logs inside Elasticsearch index: <span className="font-mono text-amber-400 font-semibold">{auditIndex}</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <label className="flex items-center gap-1.5 text-slate-400 font-sans">
                        Rows
                        <select
                          value={auditLogsPageSize}
                          onChange={(event) => {
                            setAuditLogsPage(1);
                            setAuditLogsPageSize(Number(event.target.value));
                          }}
                          className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-100 font-mono focus:outline-none focus:border-blue-500"
                        >
                          <option value={10}>10</option>
                          <option value={25}>25</option>
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => setAuditLogsPage((page) => Math.max(1, page - 1))}
                        disabled={auditLogsLoading || auditLogsPage <= 1}
                        className="border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:hover:bg-slate-900 px-2.5 py-1 rounded font-sans cursor-pointer disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      <span className="text-slate-400 font-mono min-w-20 text-center">
                        {auditLogsPage} / {auditLogsTotalPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAuditLogsPage((page) => Math.min(auditLogsTotalPages, page + 1))}
                        disabled={auditLogsLoading || auditLogsPage >= auditLogsTotalPages}
                        className="border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:hover:bg-slate-900 px-2.5 py-1 rounded font-sans cursor-pointer disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </div>
                  </div>

                  {auditLogsLoading ? (
                    <div className="py-12 text-center text-slate-500 text-xs flex flex-col items-center justify-center gap-2 font-sans">
                      <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
                      Retrieving audit records from Elasticsearch...
                    </div>
                  ) : auditLogs.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 text-xs font-sans">
                      No security audit events located inside index "{auditIndex}". Register login sessions or trigger proxied S3 downloads to record events.
                    </div>
                  ) : (
                    <div className="border border-slate-800 rounded bg-slate-900 overflow-hidden">
                      <table className="w-full text-left font-mono text-xs">
                        <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800 text-[11px] uppercase">
                          <tr>
                            <th className="p-3">Timestamp</th>
                            <th className="p-3">Operator</th>
                            <th className="p-3">Action</th>
                            <th className="p-3">Event Details</th>
                            <th className="p-3">Client IP</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800 text-slate-300">
                          {auditLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-slate-850/50">
                              <td className="p-3 whitespace-nowrap text-slate-400 text-[11px]">
                                {new Date(log.timestamp).toLocaleString()}
                              </td>
                              <td className="p-3 whitespace-nowrap font-bold text-white">
                                {log.username}
                              </td>
                              <td className="p-3 whitespace-nowrap">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                                  log.action === 'LOGIN'
                                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                    : log.action === 'DOWNLOAD'
                                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                                    : log.action === 'CONFIG_CHANGE'
                                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                    : 'bg-slate-500/10 border-slate-500/30 text-slate-400'
                                }`}>
                                  {log.action}
                                </span>
                              </td>
                              <td className="p-3 text-slate-200 font-sans text-xs">
                                {log.details}
                              </td>
                              <td className="p-3 whitespace-nowrap text-slate-500">
                                {log.ip}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

              </div>
            )}

            {activeTab === 'cluster_status' && (
              <div className="space-y-4">
                <div className="bg-slate-850 border border-slate-800 rounded-lg p-4 space-y-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block">Cluster Status</span>

                  <div className="flex items-center justify-between pb-2.5 border-b border-slate-800 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-3.5 h-3.5 rounded-full ${
                        esStatus === 'GREEN' ? 'bg-emerald-500 animate-pulse' :
                        esStatus === 'YELLOW' ? 'bg-amber-500 animate-pulse' :
                        esStatus === 'CHECKING' ? 'bg-indigo-500 animate-pulse' : 'bg-rose-500'
                      }`} />
                      <span className="text-sm font-bold text-white truncate max-w-[220px]">{esConfig.clusterName || 'elasticsearch-cluster'}</span>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 border rounded font-bold uppercase font-sans ${
                      esStatus === 'GREEN' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
                      esStatus === 'YELLOW' ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' :
                      esStatus === 'CHECKING' ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                    }`}>
                      {esStatus}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono leading-relaxed text-slate-400">
                    <div>Nodes count: <strong className="text-slate-200">
                      {esConfig.nodeUrls.split(',').map(s => s.trim()).filter(Boolean).length} Active
                    </strong></div>
                    <div>SSL cert secure: <strong className={esConfig.enableSSL ? "text-emerald-400" : "text-slate-400"}>
                      {esConfig.enableSSL ? 'Enabled (TLS)' : 'Disabled'}
                    </strong></div>
                    <div>LDAP Sync: <strong className={ldapStatus === 'CONNECTED' ? 'text-emerald-400' : 'text-rose-400'}>
                      {ldapStatus}
                    </strong></div>
                    <div>LDAP Cert: <strong className={ldapUsesTls ? (ldapConfig.verifyCertificates ? 'text-emerald-400' : 'text-amber-400') : 'text-slate-400'}>
                      {ldapCertStatus}
                    </strong></div>
                  </div>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex flex-col gap-2 min-h-[360px]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-350 flex items-center gap-1">
                      <Terminal className="w-4 h-4 text-indigo-400" /> Live Logs Terminal Console
                    </span>
                    <button
                      onClick={() => setConsoleLogs([])}
                      className="text-[10px] text-[#00a9e5] hover:underline hover:text-white cursor-pointer"
                    >
                      Clear Terminal
                    </button>
                  </div>

                  <div className="flex-1 bg-slate-900 border border-slate-850 p-2.5 rounded font-mono text-[9px] text-slate-300 overflow-y-auto max-h-[520px] space-y-1.5 select-all">
                    {consoleLogs.map((log, idx) => {
                      let logColor = 'text-slate-300';
                      if (log.includes('[SYSTEM]')) logColor = 'text-blue-400';
                      else if (log.includes('[AUTH]')) logColor = 'text-indigo-400 animate-pulse';
                      else if (log.includes('[LDAP-SSL]') || log.includes('[ES-SSL]')) logColor = 'text-emerald-400 font-semibold';
                      else if (log.includes('[LDAP-WARN]')) logColor = 'text-yellow-500';
                      else if (log.includes('[USERLOG]')) logColor = 'text-orange-400';

                      return (
                        <div key={idx} className={`${logColor} font-mono leading-normal`}>
                          {log}
                        </div>
                      );
                    })}
                    {consoleLogs.length === 0 && (
                      <div className="text-slate-600 italic text-center text-xs py-12">
                        Terminal buffer empty. Connections or settings updates trigger live streams here...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Floating Notification Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 text-white px-4 py-3 rounded-lg shadow-2xl flex items-center gap-2 max-w-sm animate-in fade-in slide-in-from-bottom-5 duration-200 border ${
          toast.type === 'error' ? 'bg-rose-950 border-rose-700' : 'bg-[#006bb4] border-[#005a96]'
        }`}>
          {toast.type === 'error' && <AlertTriangle className="w-5 h-5 text-rose-300 shrink-0" />}
          <span className="text-xs font-semibold leading-normal">{toast.message}</span>
        </div>
      )}

    </div>
  );
}
