/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { 
  Database, 
  Settings, 
  LayoutDashboard, 
  Terminal, 
  Info, 
  AlertTriangle, 
  Clock, 
  Play, 
  RefreshCw,
  Archive,
  Zap,
  BookOpen,
  Filter,
  CheckCircle2,
  PanelLeftOpen
} from 'lucide-react';

import { LogRecord, LinkRule, QueryFilter, IndexPattern, User, DiscoverConfig } from './types';
import {
  downloadS3ArchivesBulk,
  exportElasticsearchDocumentsZip,
  downloadBlob,
  convertToCSV,
  convertToJSON,
} from './utils/downloader';

import KibanaSidebar from './components/KibanaSidebar';
import KibanaHeader from './components/KibanaHeader';
import CustomDocsTable from './components/CustomDocsTable';
import KibanaLogin from './components/KibanaLogin';
import KibanaAdmin from './components/KibanaAdmin';
import { isAdminUser } from './utils/roles';

const FIELD_SELECTION_STORAGE_KEY = 'releaselogs_visible_columns_by_index_v2';
const SIDEBAR_WIDTH_STORAGE_KEY = 'releaselogs_index_sidebar_width';
const USER_SESSION_STORAGE_KEY = 'kibana_user';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;

const RELATIVE_TIME_PRESET_MINUTES: Record<string, number> = {
  'Last 15 minutes': 15,
  'Last 1 hour': 60,
  'Last 4 hours': 240,
  'Last 12 hours': 720,
  'Last 24 hours': 1440,
  'Last 7 days': 10080,
  'Last 14 days': 20160,
  'Last 30 days': 43200,
  'Last 90 days': 129600,
  'Last 6 months': 262800,
  'Last 1 year': 525600,
  'Last 2 years': 1051200,
  'Last 5 years': 2628000,
};

const getDefaultTimestampRange = () => {
  const to = new Date();
  const from = new Date(to.getTime() - RELATIVE_TIME_PRESET_MINUTES['Last 7 days'] * 60 * 1000);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label: 'Last 7 days',
  };
};

const clampSidebarWidth = (width: number) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));

const readSidebarWidth = () => {
  try {
    const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(storedWidth) ? clampSidebarWidth(storedWidth) : 320;
  } catch {
    return 320;
  }
};

type StoredUserSession = {
  user: User;
  bootId: string;
  expiresAt: number;
};

export default function App() {
  // Session Access state controllers
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<{ bootId: string; sessionTimeoutMinutes: number } | null>(null);
  const [currentPath, setCurrentPath] = useState<string>(() => {
    return window.location.pathname;
  });
  const [currentSearch, setCurrentSearch] = useState<string>(() => {
    return window.location.search;
  });

  const navigateTo = useCallback((path: string) => {
    const nextUrl = new URL(path, window.location.origin);
    window.history.pushState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    setCurrentPath(nextUrl.pathname);
    setCurrentSearch(nextUrl.search);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
      setCurrentSearch(window.location.search);
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const clearUserSession = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    try {
      localStorage.removeItem(USER_SESSION_STORAGE_KEY);
    } catch {}
    setCurrentUser(null);
  }, []);

  const persistUserSession = useCallback((user: User, info = sessionInfo) => {
    if (!info) return;
    const timeoutMinutes = Math.max(5, Number(info.sessionTimeoutMinutes) || 60);
    const session: StoredUserSession = {
      user,
      bootId: info.bootId,
      expiresAt: Date.now() + timeoutMinutes * 60 * 1000,
    };
    try {
      localStorage.setItem(USER_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {}
  }, [sessionInfo]);

  useEffect(() => {
    let active = true;

    async function validateStoredSession() {
      try {
        const res = await fetch('/api/app/session');
        const data = await res.json();
        const nextSessionInfo = {
          bootId: String(data.bootId || ''),
          sessionTimeoutMinutes: Number(data.sessionTimeoutMinutes || 60),
        };
        if (!active) return;
        setSessionInfo(nextSessionInfo);

        const raw = localStorage.getItem(USER_SESSION_STORAGE_KEY);
        if (!raw) return;
        const stored = JSON.parse(raw) as StoredUserSession | User | null;
        const storedSession = stored && typeof stored === 'object' && 'user' in stored ? stored : null;
        if (
          storedSession &&
          storedSession.bootId === nextSessionInfo.bootId &&
          Number(storedSession.expiresAt) > Date.now()
        ) {
          setCurrentUser(storedSession.user);
        } else {
          localStorage.removeItem(USER_SESSION_STORAGE_KEY);
        }
      } catch {
        try {
          localStorage.removeItem(USER_SESSION_STORAGE_KEY);
        } catch {}
      } finally {
        if (active) setAuthChecked(true);
      }
    }

    validateStoredSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const raw = localStorage.getItem(USER_SESSION_STORAGE_KEY);
    if (!raw) return;
    let expiresAt = 0;
    try {
      expiresAt = Number((JSON.parse(raw) as StoredUserSession).expiresAt);
    } catch {
      clearUserSession();
      return;
    }

    const timeout = window.setTimeout(() => {
      clearUserSession();
      navigateTo('/');
    }, Math.max(0, expiresAt - Date.now()));

    return () => window.clearTimeout(timeout);
  }, [clearUserSession, currentUser, navigateTo]);

  const [rawLogs, setRawLogs] = useState<LogRecord[]>([]);
  const [indexFields, setIndexFields] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Index Patterns
  const [indexPatterns, setIndexPatterns] = useState<IndexPattern[]>([]);
  const [selectedIndexPattern, setSelectedIndexPattern] = useState<IndexPattern | null>(null);
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);

  // Sidebar dynamic visible columns State (start with general logs views)
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);

  const [linkRules, setLinkRules] = useState<LinkRule[]>([]);

  const [defaultIndexName, setDefaultIndexName] = useState('');
  const [s3CatalogIndex, setS3CatalogIndex] = useState('');
  const [discoverConfigLoaded, setDiscoverConfigLoaded] = useState(false);
  const isAdmin = isAdminUser(currentUser);

  const handleSidebarResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };

    const handleUp = () => {
      setSidebarWidth((width) => {
        const nextWidth = clampSidebarWidth(width);
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
        } catch {}
        return nextWidth;
      });
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [sidebarWidth]);

  // Filter criteria
  const [filter, setFilter] = useState<QueryFilter>(() => ({
    queryText: '',
    timestampRange: getDefaultTimestampRange(),
    levels: ['info', 'warn', 'error'],
  }));

  // Selected row documents checker state
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  // Normalize ES documents (access logs use _id/_index; audit logs use id/index)
  const normalizeLogRecord = (raw: Record<string, unknown>, fallbackIndex?: string): LogRecord => {
    const r = raw as LogRecord & Record<string, unknown>;
    return {
      ...r,
      _id: String(r._id ?? r.id ?? ''),
      _index: String(r._index ?? r.index ?? fallbackIndex ?? ''),
      timestamp: String(r.timestamp ?? ''),
      level: (r.level as LogRecord['level']) ?? 'info',
      method: String(r.method ?? ''),
      status: Number(r.status ?? 0),
      request_path: String(r.request_path ?? ''),
      ip: String(r.ip ?? ''),
      bytes: Number(r.bytes ?? 0),
      country: String(r.country ?? ''),
      user_agent: String(r.user_agent ?? ''),
      download_url: String(r.download_url ?? ''),
      archive_name: String(r.archive_name ?? ''),
      s3_key: r.s3_key ? String(r.s3_key) : undefined,
      size_bytes: r.size_bytes != null ? Number(r.size_bytes) : undefined,
      content_type: r.content_type ? String(r.content_type) : undefined,
      description: r.description ? String(r.description) : undefined,
    };
  };

  const normalizeFieldName = (field: string) => {
    if (field === 'id') return '_id';
    if (field === 'index') return '_index';
    return field;
  };

  const sortFields = (fields: string[]) => {
    const pinned = ['_id', '_index', 'level', 'method', 'status', 'request_path', 'ip'];
    return [...fields].sort((a, b) => {
      const aPinned = pinned.indexOf(a);
      const bPinned = pinned.indexOf(b);
      if (aPinned !== -1 || bPinned !== -1) {
        if (aPinned === -1) return 1;
        if (bPinned === -1) return -1;
        return aPinned - bPinned;
      }
      return a.localeCompare(b);
    });
  };

  const getAvailableFieldsFromDocuments = (docs: Record<string, unknown>[]) => {
    const fields = new Set<string>();
    docs.forEach((doc) => {
      Object.keys(doc).forEach((key) => {
        const fieldName = normalizeFieldName(key);
        if (fieldName !== 'timestamp') fields.add(fieldName);
      });
    });
    return sortFields(Array.from(fields));
  };

  const selectedIndexFromUrl = useMemo(() => {
    return new URLSearchParams(currentSearch).get('index') || '';
  }, [currentSearch]);
  const activeFieldSelectionIndex = selectedIndexPattern?.name || selectedIndexFromUrl || defaultIndexName;

  const readStoredVisibleColumns = (indexName: string): string[] | null => {
    try {
      const raw = localStorage.getItem(FIELD_SELECTION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const columns = parsed[indexName];
      return Array.isArray(columns) ? columns.filter((column): column is string => typeof column === 'string') : null;
    } catch {
      return null;
    }
  };

  const saveStoredVisibleColumns = (indexName: string, columns: string[]) => {
    try {
      const raw = localStorage.getItem(FIELD_SELECTION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Record<string, string[]> : {};
      localStorage.setItem(FIELD_SELECTION_STORAGE_KEY, JSON.stringify({ ...parsed, [indexName]: columns }));
    } catch {
      // Ignore localStorage failures; field selection still works for the current session.
    }
  };

  const updateSelectedIndexUrl = useCallback((indexName: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('index', indexName);
    const nextSearch = `?${params.toString()}`;
    window.history.pushState(null, '', `${window.location.pathname}${nextSearch}`);
    setCurrentPath(window.location.pathname);
    setCurrentSearch(nextSearch);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    setDiscoverConfigLoaded(false);
    fetch('/api/discover/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.config?.defaultIndex) {
          setDefaultIndexName(data.config.defaultIndex);
        }
        if (Array.isArray(data.config?.linkRules)) {
          setLinkRules(data.config.linkRules);
        }
        setS3CatalogIndex(String(data.config?.s3CatalogIndex || ''));
      })
      .catch(() => {})
      .finally(() => setDiscoverConfigLoaded(true));
  }, [currentUser?.id, currentPath]);

  useEffect(() => {
    if (!currentUser) return;
    if (
      !isAdminUser(currentUser) &&
      (currentPath === '/management' ||
        currentPath.startsWith('/management') ||
        currentPath === '/s3' ||
        currentPath.startsWith('/s3'))
    ) {
      navigateTo('/');
    }
  }, [currentPath, currentUser]);

  useEffect(() => {
    if (!currentUser || isAdminUser(currentUser) || !defaultIndexName) return;
    const existing = indexPatterns.find((pattern) => pattern.name === defaultIndexName);
    if (existing) {
      setIndexPatterns([existing]);
      setSelectedIndexPattern(existing);
    }
  }, [defaultIndexName, currentUser?.id, indexPatterns.length]);

  useEffect(() => {
    if (!currentUser || !discoverConfigLoaded) return;
    fetch('/api/es-indices')
      .then((res) => res.json())
      .then((data) => {
        const loadedPatterns: IndexPattern[] = Array.isArray(data.indices)
          ? data.indices.map((idx: any) => ({
              id: idx.index,
              name: idx.index,
              description: `Index partition for ${idx.index}.`,
              count: Number(idx['docs.count'] ?? 0),
            }))
          : [];

        if (isAdminUser(currentUser)) {
          setIndexPatterns(loadedPatterns);
          const urlSelected = loadedPatterns.find((pattern) => pattern.name === selectedIndexFromUrl);
          const defaultSelected = loadedPatterns.find((pattern) => pattern.name === defaultIndexName);
          setSelectedIndexPattern((current) =>
            urlSelected ||
            (!selectedIndexFromUrl ? defaultSelected : null) ||
            loadedPatterns.find((pattern) => pattern.name === current?.name) ||
            loadedPatterns[0] ||
            null
          );
        } else {
          const assigned = loadedPatterns.find((pattern) => pattern.name === defaultIndexName) || loadedPatterns[0] || null;
          setIndexPatterns(assigned ? [assigned] : []);
          setSelectedIndexPattern(assigned);
        }
      })
      .catch((err) => console.error('Failed to load indices', err));
  }, [currentUser?.id, defaultIndexName, selectedIndexFromUrl, discoverConfigLoaded]);

  // Fetch dataset from backend Elasticsearch proxy
  const fetchLogs = (targetIndexOverride?: string) => {
    setIsRefreshing(true);

    const targetIndex =
      targetIndexOverride ||
      (isAdminUser(currentUser)
        ? selectedIndexFromUrl || defaultIndexName || selectedIndexPattern?.name
        : defaultIndexName || selectedIndexPattern?.name) ||
      '*';
    const params = new URLSearchParams({ index: targetIndex });
    const queryText = filter.queryText.trim();
    const isAllAvailableTime = filter.timestampRange.label === 'All available';
    if (queryText && queryText !== '*') params.set('q', queryText);
    if (!isAllAvailableTime && filter.timestampRange.from) params.set('from', filter.timestampRange.from);
    if (!isAllAvailableTime && filter.timestampRange.to) params.set('to', filter.timestampRange.to);

    fetch('/api/es-indices')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.indices)) {
          const loadedPatterns = data.indices.map((idx: any) => ({
            id: idx.index,
            name: idx.index,
            description: `Index partition for ${idx.index}.`,
            count: Number(idx['docs.count'] ?? 0),
          }));

          if (isAdminUser(currentUser)) {
            setIndexPatterns(loadedPatterns);
          } else {
            const def = loadedPatterns.find((p: IndexPattern) => p.name === defaultIndexName) || loadedPatterns[0] || null;
            setIndexPatterns(def ? [def] : []);
          }
        }
      })
      .catch((err) => console.error('Failed to load indices', err));

    fetch(`/api/logs?${params.toString()}`)
      .then(res => res.json())
      .then(data => {
        const sourceLogs = data.logs || [];
        setIndexFields(getAvailableFieldsFromDocuments(sourceLogs));
        const logs = sourceLogs.map((log: Record<string, unknown>) =>
          normalizeLogRecord(log, targetIndex)
        );
        setRawLogs(logs);
        setIsRefreshing(false);
      })
      .catch((err) => {
        console.error("Failed to pull from ES proxy", err);
        setIsRefreshing(false);
      });
  };

  useEffect(() => {
    if (!discoverConfigLoaded) return;
    const indexToLoad = isAdmin
      ? selectedIndexFromUrl || defaultIndexName || selectedIndexPattern?.name
      : defaultIndexName || selectedIndexPattern?.name;
    if (indexToLoad) fetchLogs(indexToLoad);
  }, [
    selectedIndexFromUrl,
    selectedIndexPattern?.name,
    defaultIndexName,
    isAdmin,
    discoverConfigLoaded,
    filter.queryText,
    filter.timestampRange.from,
    filter.timestampRange.to,
  ]);

  // Soft refresh data simulator
  const handleRefreshData = () => {
    const minutes = RELATIVE_TIME_PRESET_MINUTES[filter.timestampRange.label];
    if (minutes) {
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - minutes * 60 * 1000);
      setFilter((current) => ({
        ...current,
        timestampRange: {
          ...current.timestampRange,
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
      }));
    } else {
      fetchLogs();
    }
    showToast('Refreshing results from Elasticsearch.');
  };

  const showToast = (message: string, type?: 'success' | 'error') => {
    const inferredType = type || (/\b(error|failed|fail|denied|invalid|not found|unavailable)\b/i.test(message) ? 'error' : 'success');
    setToast({ message, type: inferredType });
    setTimeout(() => {
      setToast(null);
    }, 3000);
  };

  // List fields from the currently selected index documents only.
  const availableFields = useMemo(() => {
    return indexFields;
  }, [indexFields]);

  useEffect(() => {
    if (availableFields.length === 0 || !activeFieldSelectionIndex) return;
    const storedColumns = readStoredVisibleColumns(activeFieldSelectionIndex);
    if (storedColumns) {
      setVisibleColumns(storedColumns.filter((column) => availableFields.includes(column)));
      return;
    }
    setVisibleColumns(availableFields);
  }, [availableFields, activeFieldSelectionIndex]);

  // Toggle active displaying columns
  const handleToggleColumn = (field: string) => {
    setVisibleColumns(prev => {
      if (prev.includes(field)) {
        const next = prev.filter(col => col !== field);
        if (activeFieldSelectionIndex) saveStoredVisibleColumns(activeFieldSelectionIndex, next);
        return next;
      }
      const next = [...prev, field];
      if (activeFieldSelectionIndex) saveStoredVisibleColumns(activeFieldSelectionIndex, next);
      return next;
    });
  };

  const handleClearVisibleColumns = () => {
    setVisibleColumns([]);
    if (activeFieldSelectionIndex) saveStoredVisibleColumns(activeFieldSelectionIndex, []);
  };

  const saveDiscoverConfig = (config: Partial<DiscoverConfig>) => {
    return fetch('/api/discover/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }).then((res) => res.json());
  };

  // Add / edit link templates
  const handleAddLinkRule = (rule: LinkRule) => {
    setLinkRules(prev => {
      // Overwrite existing column rules or push new
      const filtered = prev.filter(r => r.columnName !== rule.columnName);
      const next = [...filtered, rule];
      saveDiscoverConfig({ linkRules: next }).catch((err) => {
        showToast(`Failed to save link rule: ${err.message}`);
      });
      return next;
    });
    showToast(`Created dynamic custom linking template rule for column "${rule.columnName}"`);
  };

  const handleDeleteLinkRule = (columnName: string) => {
    setLinkRules(prev => {
      const next = prev.filter(r => r.columnName !== columnName);
      saveDiscoverConfig({ linkRules: next }).catch((err) => {
        showToast(`Failed to save link rules: ${err.message}`);
      });
      return next;
    });
    showToast(`Deleted custom link trigger configurations for "${columnName}"`);
  };

  // Elasticsearch already applies query text and time range; keep the table view as the returned hit set.
  const filteredRecords = useMemo(() => {
    return rawLogs;
  }, [rawLogs]);

  // Row selection handler
  const handleToggleRowSelection = (id: string) => {
    setSelectedRowIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleClearAllSelections = () => {
    setSelectedRowIds(new Set());
  };

  // Global page row selection toggler
  const handleToggleAllRowsSelection = (currentPageIds: string[]) => {
    setSelectedRowIds(prev => {
      const next = new Set(prev);
      const isEveryCurrentSelected = currentPageIds.every(id => next.has(id));
      
      if (isEveryCurrentSelected) {
        // Deselect current page items
        currentPageIds.forEach(id => next.delete(id));
      } else {
        // Select all current page items
        currentPageIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  // Quick action: Adds new phrase constraint filter onto query box (Kibana behavior!)
  const handleAddSearchPhrase = (phrase: string) => {
    setFilter(prev => {
      const cleanPrev = prev.queryText.trim();
      const newQuery = cleanPrev ? `${cleanPrev} AND ${phrase}` : phrase;
      return { ...prev, queryText: newQuery };
    });
    showToast(`Added query criteria parameter: "${phrase}"`);
  };

  // Selected Log objects mapped lists for exports
  const selectedRecords = useMemo(() => {
    return rawLogs.filter(log => selectedRowIds.has(log._id));
  }, [rawLogs, selectedRowIds]);

  // DOWNLOAD: fetch actual S3/MinIO zip archives for selected rows
  const handleDownloadS3Archives = async () => {
    if (selectedRecords.length === 0) return;
    if (!s3CatalogIndex || selectedRecords.some((record) => record._index !== s3CatalogIndex)) {
      showToast(`S3 archive downloads are only available for records in ${s3CatalogIndex || 'the configured S3 catalog index'}.`, 'error');
      return;
    }
    const result = await downloadS3ArchivesBulk(selectedRecords, currentUser?.username);
    if (result.success === true) {
      showToast(`Downloaded S3 archive bundle for ${selectedRecords.length} selected document(s).`);
    } else {
      showToast(result.error, 'error');
    }
  };

  // EXPORT: Elasticsearch document data (not S3 payloads)
  const handleExportEsZip = async () => {
    if (selectedRecords.length === 0) return;
    const timestampStr = new Date().toISOString().slice(0, 10);
    const filename = `elasticsearch_export_${timestampStr}.zip`;
    const success = await exportElasticsearchDocumentsZip(selectedRecords, filename);
    if (success) {
      showToast(`Exported ${selectedRecords.length} Elasticsearch documents as ZIP.`);
    } else {
      showToast(`Export failed. Please try again.`);
    }
  };

  const handleDownloadBulkCSV = () => {
    if (selectedRecords.length === 0) return;
    const csvData = convertToCSV(selectedRecords);
    const timestampStr = new Date().toISOString().slice(0, 10);
    downloadBlob(csvData, `elastic_export_${timestampStr}.csv`, 'text/csv');
    showToast(`Exported CSV list compilation representing checked telemetry!`);
  };

  // 3. Bulk download selected logs unified JSON array
  const handleDownloadBulkJSON = () => {
    if (selectedRecords.length === 0) return;
    const jsonData = convertToJSON(selectedRecords);
    const timestampStr = new Date().toISOString().slice(0, 10);
    downloadBlob(jsonData, `elastic_export_${timestampStr}.json`, 'application/json');
    showToast(`Exported JSON dataset array spreadsheet!`);
  };

  // Auth gate to prevent unauthorized access
  if (!authChecked) {
    return (
      <div className="h-screen w-screen bg-slate-950" />
    );
  }

  if (!currentUser) {
    return (
      <KibanaLogin 
        onLoginSuccess={async (u) => {
          let nextSessionInfo = sessionInfo;
          if (!nextSessionInfo) {
            try {
              const res = await fetch('/api/app/session');
              const data = await res.json();
              nextSessionInfo = {
                bootId: String(data.bootId || ''),
                sessionTimeoutMinutes: Number(data.sessionTimeoutMinutes || 60),
              };
              setSessionInfo(nextSessionInfo);
            } catch {
              nextSessionInfo = null;
            }
          }
          persistUserSession(u, nextSessionInfo);
          setCurrentUser(u);
          fetch('/api/audit/register-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: u.username,
              fullName: u.fullName,
              department: u.department,
              authType: u.type
            })
          }).catch(err => console.error('Failed to register login audit event:', err));
        }} 
      />
    );
  }

  // Administrator subpage (admins only; viewers redirected above)
  if (currentPath === '/management' || currentPath.startsWith('/management')) {
    if (!isAdmin) {
      return null;
    }
    return (
      <KibanaAdmin
        currentUser={currentUser}
        currentPath={currentPath}
        onLogout={() => {
          clearUserSession();
          navigateTo('/');
        }}
        onBackToSearch={() => navigateTo('/')}
        onNavigateToSection={navigateTo}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-white text-slate-900 font-sans overflow-hidden">
      
      {/* Kibana Search Header Row */}
      <KibanaHeader
        filter={filter}
        onChangeFilter={setFilter}
        onRefreshData={handleRefreshData}
        totalAvailable={rawLogs.length}
        filteredCount={filteredRecords.length}
        isRefreshing={isRefreshing}
        currentUser={currentUser}
        onLogout={() => {
          clearUserSession();
          navigateTo('/');
        }}
        onNavigateToAdmin={isAdmin ? () => navigateTo('/management/app') : undefined}
      />

      {/* Main Core View Area */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Hand Index Pattern Sidebar Fields manager */}
        {isSidebarVisible && (
          <KibanaSidebar
            width={sidebarWidth}
            indexPatterns={indexPatterns}
            selectedIndexPattern={selectedIndexPattern}
            onSelectIndexPattern={(pattern) => {
              setSelectedIndexPattern(pattern);
              updateSelectedIndexUrl(pattern.name);
              setSelectedRowIds(new Set());
            }}
            availableFields={availableFields}
            visibleColumns={visibleColumns}
            onToggleColumn={handleToggleColumn}
            onClearVisibleColumns={handleClearVisibleColumns}
            linkRules={linkRules}
            onAddLinkRule={handleAddLinkRule}
            onDeleteLinkRule={handleDeleteLinkRule}
            isAdmin={isAdmin}
            onClose={() => setIsSidebarVisible(false)}
            onResizeStart={handleSidebarResizeStart}
          />
        )}
        {!isSidebarVisible && (
          <button
            type="button"
            onClick={() => setIsSidebarVisible(true)}
            className="h-full w-10 shrink-0 border-r border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 cursor-pointer flex items-start justify-center pt-4"
            title="Open index pattern sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        {/* Center results column view */}
        <main className="flex-1 min-w-0 flex flex-col bg-slate-50 overflow-y-auto" id="kibana-main-viewport">
          
          {/* Core Results Interactive Log documents Grid list */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-[400px]">
            <CustomDocsTable
              records={filteredRecords}
              visibleColumns={visibleColumns}
              linkRules={linkRules}
              s3CatalogIndex={s3CatalogIndex}
              queryText={filter.queryText}
              onAddSearchPhrase={handleAddSearchPhrase}
              selectedRowIds={selectedRowIds}
              onToggleRowSelection={handleToggleRowSelection}
              onToggleAllRowsSelection={handleToggleAllRowsSelection}
              onClearAllSelections={handleClearAllSelections}
              onDownloadS3Archives={handleDownloadS3Archives}
              onExportEsZip={handleExportEsZip}
              onExportCSV={handleDownloadBulkCSV}
              onExportJSON={handleDownloadBulkJSON}
            />
          </div>

        </main>
      </div>

      {/* Success Notify Floating Toast bar */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 text-white border px-4 py-3 rounded-lg shadow-2xl flex items-center gap-2.5 max-w-sm font-sans animate-in fade-in slide-in-from-bottom-5 duration-200 ${
          toast.type === 'error' ? 'bg-rose-950 border-rose-700' : 'bg-[#006bb4] border-[#005a96]'
        }`}>
          {toast.type === 'error' && <AlertTriangle className="w-5 h-5 text-rose-300 shrink-0" />}
          <span className="text-xs font-semibold leading-normal">{toast.message}</span>
        </div>
      )}

    </div>
  );
}
