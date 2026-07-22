/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo, ChangeEvent, FormEvent } from 'react';
import {
  ArrowLeft,
  Search,
  Upload,
  Trash2,
  Download,
  RefreshCw,
  Filter,
  Edit2,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  FolderOpen,
  X,
} from 'lucide-react';
import { User, S3File } from '../types';

interface KibanaS3ManagerProps {
  currentUser: User;
  /** Full-page mode (legacy route); omit header when embedded in Administrator */
  embedded?: boolean;
  onLogout?: () => void;
  onBackToDiscover?: () => void;
  onNotify?: (message: string) => void;
}

export default function KibanaS3Manager({
  currentUser,
  embedded = false,
  onLogout,
  onBackToDiscover,
  onNotify,
}: KibanaS3ManagerProps) {
  const [files, setFiles] = useState<S3File[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [prefix, setPrefix] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [activeView, setActiveView] = useState<'objects' | 'monitoring'>('objects');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState('');
  const [newObjectKey, setNewObjectKey] = useState('');
  const [newObjectDescription, setNewObjectDescription] = useState('');

  const showToast = (msg: string) => {
    const type = /\b(error|failed|fail|denied|invalid|not found|unavailable)\b/i.test(msg) ? 'error' : 'success';
    if (onNotify) onNotify(msg);
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchFiles = async (overrides?: { search?: string; prefix?: string; typeFilter?: string }) => {
    setLoading(true);
    const params = new URLSearchParams();
    const nextSearch = overrides?.search ?? search;
    const nextPrefix = overrides?.prefix ?? prefix;
    const nextTypeFilter = overrides?.typeFilter ?? typeFilter;
    if (nextSearch) params.set('search', nextSearch);
    if (nextPrefix) params.set('prefix', nextPrefix);
    if (nextTypeFilter !== 'all') params.set('type', nextTypeFilter);

    try {
      const res = await fetch(`/api/s3/list?${params.toString()}`);
      const data = await res.json();
      if (data.status === 'success') {
        setFiles(data.files || []);
        setSource(data.source || '');
        setCurrentPage(1);
      }
    } catch (err: any) {
      showToast(`Failed to list files: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  const filteredCount = files.length;

  const prefixOptions = useMemo(() => {
    const prefixes = new Set<string>();
    files.forEach((f) => {
      const slash = f.key.indexOf('/');
      if (slash > 0) prefixes.add(f.key.slice(0, slash + 1));
    });
    return ['', ...Array.from(prefixes).sort()];
  }, [files]);

  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedFiles = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return files.slice(start, start + pageSize);
  }, [files, pageSize, safePage]);

  const storageStats = useMemo(() => {
    const byPrefix = new Map<string, { count: number; bytes: number }>();
    const byType = new Map<string, { count: number; bytes: number }>();
    let totalBytes = 0;

    files.forEach((file) => {
      totalBytes += file.size;
      const slash = file.key.indexOf('/');
      const prefixName = slash > 0 ? file.key.slice(0, slash + 1) : '(root)';
      const typeName = file.contentType || 'application/octet-stream';
      const prefixEntry = byPrefix.get(prefixName) || { count: 0, bytes: 0 };
      const typeEntry = byType.get(typeName) || { count: 0, bytes: 0 };
      prefixEntry.count += 1;
      prefixEntry.bytes += file.size;
      typeEntry.count += 1;
      typeEntry.bytes += file.size;
      byPrefix.set(prefixName, prefixEntry);
      byType.set(typeName, typeEntry);
    });

    return {
      totalBytes,
      prefixes: Array.from(byPrefix.entries()).sort((a, b) => b[1].bytes - a[1].bytes),
      types: Array.from(byType.entries()).sort((a, b) => b[1].bytes - a[1].bytes),
      largest: [...files].sort((a, b) => b.size - a.size).slice(0, 5),
    };
  }, [files]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    fetchFiles();
  };

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const normalizeObjectKey = (value: string) =>
      value
        .trim()
        .replace(/^\/+/, '')
        .split('/')
        .map((part) => part.replace(/\s+/g, ''))
        .filter(Boolean)
        .join('/');

    const requestedKey = newObjectKey.trim().replace(/^\/+/, '');
    const key = requestedKey
      ? requestedKey.endsWith('/') ? normalizeObjectKey(`${requestedKey}${file.name}`) : normalizeObjectKey(requestedKey)
      : normalizeObjectKey(file.name);
    setUploading(true);

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = (reader.result as string).split(',')[1] || '';
        const res = await fetch('/api/s3/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key,
            fileContent: base64,
            contentType: file.type || 'application/octet-stream',
            description: newObjectDescription || `Uploaded by ${currentUser.username}`,
          }),
        });
        const data = await res.json();
        if (data.status === 'success') {
          showToast(`Uploaded [${data.key || key}] to storage.`);
          setNewObjectKey('');
          setNewObjectDescription('');
          fetchFiles();
        } else {
          showToast(data.error || 'Upload failed');
        }
      } catch (err: any) {
        showToast(err.message);
      } finally {
        setUploading(false);
        e.target.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete object "${key}" from storage and catalog?`)) return;
    try {
      const res = await fetch(`/api/s3/object?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.status === 'success') {
        showToast(`Deleted [${key}]`);
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        fetchFiles();
      } else {
        showToast(data.error || 'Delete failed');
      }
    } catch (err: any) {
      showToast(err.message);
    }
  };

  const handleSaveDescription = async (key: string) => {
    try {
      const res = await fetch('/api/s3/object', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, description: editDescription }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        showToast('Metadata updated and catalog re-indexed.');
        setEditingKey(null);
        fetchFiles();
      }
    } catch (err: any) {
      showToast(err.message);
    }
  };

  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const downloadSelected = () => {
    selectedKeys.forEach((key) => {
      const a = document.createElement('a');
      a.href = `/api/s3/proxy-download?key=${encodeURIComponent(key)}&username=${encodeURIComponent(currentUser.username)}`;
      a.download = key.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    showToast(`Started download for ${selectedKeys.size} file(s).`);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const content = (
    <div className={`${embedded ? 'space-y-4' : 'flex-1 overflow-y-auto p-4 space-y-4 max-w-7xl mx-auto w-full'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex border border-slate-800 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setActiveView('objects')}
              className={`px-4 py-2 text-xs font-semibold cursor-pointer ${
                activeView === 'objects'
                  ? 'bg-[#006bb4] text-white'
                  : 'bg-slate-900 text-slate-400 hover:text-white'
              }`}
            >
              Objects
            </button>
            <button
              type="button"
              onClick={() => setActiveView('monitoring')}
              className={`px-4 py-2 text-xs font-semibold cursor-pointer ${
                activeView === 'monitoring'
                  ? 'bg-[#006bb4] text-white'
                  : 'bg-slate-900 text-slate-400 hover:text-white'
              }`}
            >
              Storage Monitoring
            </button>
          </div>
          <span className="text-[10px] text-slate-500 font-mono">
            Source: {source || 'not loaded'}
          </span>
        </div>

        {activeView === 'objects' && (
          <>
        {/* Toolbar */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3">
          <form onSubmit={handleSearch} className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">Search</label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-2 text-slate-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Key or description…"
                  className="w-full bg-slate-950 border border-slate-700 rounded pl-9 pr-3 py-1.5 text-xs font-mono text-white"
                />
              </div>
            </div>
            <div className="w-40">
              <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">Prefix</label>
              <select
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-white"
              >
                <option value="">All prefixes</option>
                {prefixOptions.filter(Boolean).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-32">
              <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">Type</label>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-white"
              >
                <option value="all">All</option>
                <option value="zip">ZIP</option>
                <option value="pdf">PDF</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <button
              type="submit"
              className="bg-[#006bb4] hover:bg-[#005a96] text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-1.5 cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              Apply filters
            </button>
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setPrefix('');
                setTypeFilter('all');
                fetchFiles({ search: '', prefix: '', typeFilter: 'all' });
              }}
              className="text-slate-400 hover:text-white text-xs px-2 py-2 cursor-pointer"
            >
              Clear
            </button>
          </form>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
            <button
              onClick={() => fetchFiles()}
              disabled={loading}
              className="text-amber-400 border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {selectedKeys.size > 0 && (
              <>
                <button
                  onClick={downloadSelected}
                  className="bg-[#006bb4] text-white text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download ({selectedKeys.size})
                </button>
                <button
                  onClick={() => setSelectedKeys(new Set())}
                  className="text-slate-400 text-xs px-2 cursor-pointer"
                >
                  Clear selection
                </button>
              </>
            )}
          </div>
        </div>

        {/* Upload */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <h2 className="text-xs font-bold text-white uppercase tracking-wide mb-3 flex items-center gap-2">
            <Upload className="w-4 h-4 text-blue-400" />
            Upload object
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] uppercase text-slate-500 font-bold">Object key (path)</label>
              <input
                value={newObjectKey}
                onChange={(e) => setNewObjectKey(e.target.value)}
                placeholder=""
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase text-slate-500 font-bold">Description (catalog)</label>
              <input
                value={newObjectDescription}
                onChange={(e) => setNewObjectDescription(e.target.value)}
                placeholder="Optional description for Elasticsearch"
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono"
              />
            </div>
            <div className="flex items-end">
              <label className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-1.5 cursor-pointer w-full justify-center">
                {uploading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Choose file
                <input type="file" accept=".zip,.pdf,.json,.gz" onChange={handleUpload} disabled={uploading} className="hidden" />
              </label>
            </div>
          </div>
        </div>

        {/* File table */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-bold text-white flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-slate-400" />
              {filteredCount} object{filteredCount !== 1 ? 's' : ''}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">S3 object catalog</span>
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-500 text-xs">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2 text-blue-500" />
              Loading bucket…
            </div>
          ) : files.length === 0 ? (
            <div className="py-16 text-center text-slate-500 text-xs">
              No objects match your filters. Upload a file or adjust the filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="p-3 w-10" />
                    <th className="p-3">Key</th>
                    <th className="p-3">Description</th>
                    <th className="p-3">Type</th>
                    <th className="p-3">Size</th>
                    <th className="p-3">Modified</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {paginatedFiles.map((file) => (
                    <tr key={file.key} className="hover:bg-slate-850/50">
                      <td className="p-3 text-center">
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(file.key)}
                          onChange={() => toggleSelect(file.key)}
                          className="rounded border-slate-600"
                        />
                      </td>
                      <td className="p-3">
                        <span className="text-white font-semibold block">{file.key}</span>
                        <span className="text-[10px] text-slate-500">{file.download_url}</span>
                      </td>
                      <td className="p-3 max-w-xs">
                        {editingKey === file.key ? (
                          <div className="flex gap-1">
                            <input
                              value={editDescription}
                              onChange={(e) => setEditDescription(e.target.value)}
                              className="flex-1 bg-slate-950 border border-slate-600 rounded px-2 py-1 text-[11px]"
                            />
                            <button
                              onClick={() => handleSaveDescription(file.key)}
                              className="text-emerald-400 p-1 cursor-pointer"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                            </button>
                            <button onClick={() => setEditingKey(null)} className="text-slate-500 p-1 cursor-pointer">
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-slate-400 font-sans text-[11px]">
                            {file.description || '—'}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px]">{file.contentType}</span>
                      </td>
                      <td className="p-3 text-slate-400">{formatSize(file.size)}</td>
                      <td className="p-3 text-slate-400 font-sans">
                        {new Date(file.lastModified).toLocaleString()}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <a
                            href={`/api/s3/proxy-download?key=${encodeURIComponent(file.key)}&username=${encodeURIComponent(currentUser.username)}`}
                            className="p-1.5 text-blue-400 hover:bg-slate-800 rounded cursor-pointer"
                            title="Download"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                          <button
                            onClick={() => {
                              setEditingKey(file.key);
                              setEditDescription(file.description || '');
                            }}
                            className="p-1.5 text-amber-400 hover:bg-slate-800 rounded cursor-pointer"
                            title="Edit description"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(file.key)}
                            className="p-1.5 text-rose-400 hover:bg-slate-800 rounded cursor-pointer"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="font-mono">
                    Page {safePage} of {totalPages}
                  </span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white"
                  >
                    <option value={10}>10 rows</option>
                    <option value={25}>25 rows</option>
                    <option value={50}>50 rows</option>
                    <option value={100}>100 rows</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={safePage === 1}
                    className="px-3 py-1 rounded border border-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    disabled={safePage === totalPages}
                    className="px-3 py-1 rounded border border-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
          </>
        )}

        {activeView === 'monitoring' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Objects</div>
                <div className="text-2xl font-bold text-white mt-1">{files.length}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Stored size</div>
                <div className="text-2xl font-bold text-white mt-1">{formatSize(storageStats.totalBytes)}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Prefixes</div>
                <div className="text-2xl font-bold text-white mt-1">{storageStats.prefixes.length}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Selected</div>
                <div className="text-2xl font-bold text-white mt-1">{selectedKeys.size}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 text-xs font-bold text-white uppercase">Usage by prefix</div>
                <div className="divide-y divide-slate-800">
                  {storageStats.prefixes.slice(0, 10).map(([name, stat]) => (
                    <div key={name} className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-200 font-mono truncate">{name}</span>
                      <span className="text-slate-400 whitespace-nowrap">{stat.count} objects / {formatSize(stat.bytes)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 text-xs font-bold text-white uppercase">Usage by content type</div>
                <div className="divide-y divide-slate-800">
                  {storageStats.types.slice(0, 10).map(([name, stat]) => (
                    <div key={name} className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-200 font-mono truncate">{name}</span>
                      <span className="text-slate-400 whitespace-nowrap">{stat.count} objects / {formatSize(stat.bytes)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 text-xs font-bold text-white uppercase">Largest objects</div>
                <div className="divide-y divide-slate-800">
                  {storageStats.largest.map((file) => (
                    <div key={file.key} className="px-4 py-3 text-xs">
                      <div className="text-slate-200 font-mono truncate">{file.key}</div>
                      <div className="text-slate-500 mt-1">{formatSize(file.size)} / {new Date(file.lastModified).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  );

  if (embedded) {
    return (
      <div className="relative">
        {content}
        {toast && (
          <div className={`fixed bottom-4 right-4 z-50 text-white border px-4 py-3 rounded-lg shadow-xl flex items-center gap-2 max-w-sm text-xs font-semibold ${
            toast.type === 'error' ? 'bg-rose-950 border-rose-700' : 'bg-[#006bb4] border-[#005a96]'
          }`}>
            {toast.type === 'error' && <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0" />}
            {toast.message}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans">
      {onBackToDiscover && (
        <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={onBackToDiscover}
              className="text-slate-400 hover:text-white flex items-center gap-1.5 text-xs font-medium cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              Discover
            </button>
            <div className="h-5 w-px bg-slate-700" />
            <HardDrive className="w-5 h-5 text-amber-400" />
            <div>
              <h1 className="text-sm font-bold text-white uppercase tracking-wide">S3 / MinIO Storage</h1>
              <p className="text-[10px] text-slate-500 font-mono">CRUD · search · catalog sync</p>
            </div>
          </div>
          {onLogout && (
            <button onClick={onLogout} className="text-xs text-slate-400 hover:text-white px-2 py-1 cursor-pointer">
              Logout
            </button>
          )}
        </header>
      )}

      <main className="flex-1 overflow-y-auto p-4 space-y-4 max-w-7xl mx-auto w-full">
        {content}
      </main>

      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 text-white border px-4 py-3 rounded-lg shadow-xl flex items-center gap-2 max-w-sm text-xs font-semibold ${
          toast.type === 'error' ? 'bg-rose-950 border-rose-700' : 'bg-[#006bb4] border-[#005a96]'
        }`}>
          {toast.type === 'error' && <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
