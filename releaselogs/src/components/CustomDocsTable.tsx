/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, Fragment, useMemo, useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Copy,
  Plus,
  Terminal,
  Archive,
  FileCheck,
  FileSpreadsheet,
  Settings,
  AlertCircle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { LogRecord, LinkRule } from '../types';
import { getS3KeyFromRecord } from '../utils/downloader';
import { getSearchHighlightTerms } from '../utils/searchQuery';

const COLUMN_WIDTH_STORAGE_KEY = 'releaselogs_manual_column_widths';
const MIN_COLUMN_WIDTH = 90;
const MAX_COLUMN_WIDTH = 720;
const CHARACTER_WIDTH_PX = 7.5;
const CELL_PADDING_PX = 52;

interface CustomDocsTableProps {
  records: LogRecord[];
  visibleColumns: string[];
  linkRules: LinkRule[];
  s3CatalogIndex: string;
  queryText: string;
  onAddSearchPhrase: (phrase: string) => void;
  selectedRowIds: Set<string>;
  onToggleRowSelection: (id: string) => void;
  onToggleAllRowsSelection: (currentPageIds: string[]) => void;
  onClearAllSelections: () => void;
  onDownloadS3Archives: () => void;
  onExportEsZip: () => void;
  onExportCSV: () => void;
  onExportJSON: () => void;
}

const clampColumnWidth = (width: number) => Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.ceil(width)));

const stringifyCellValue = (value: unknown) => {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const formatTableTimestamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const twoDigit = (part: number) => String(part).padStart(2, '0');
  return [
    twoDigit(date.getDate()),
    twoDigit(date.getMonth() + 1),
    date.getFullYear(),
  ].join('.') + `, ${twoDigit(date.getHours())}:${twoDigit(date.getMinutes())}:${twoDigit(date.getSeconds())}`;
};

const getDisplayValue = (record: LogRecord, column: string) => {
  if (column === 'timestamp') {
    return formatTableTimestamp(record.timestamp);
  }
  return stringifyCellValue((record as unknown as Record<string, unknown>)[column]);
};

const getLongestTextLength = (text: string) => {
  return text.split(/\r?\n/).reduce((longest, line) => Math.max(longest, line.length), 0);
};

const estimateColumnWidth = (label: string, values: string[], minWidth = MIN_COLUMN_WIDTH) => {
  const longest = values.reduce(
    (maxLength, value) => Math.max(maxLength, getLongestTextLength(value)),
    label.length
  );
  return Math.max(minWidth, clampColumnWidth(longest * CHARACTER_WIDTH_PX + CELL_PADDING_PX));
};

const readManualColumnWidths = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    );
  } catch {
    return {};
  }
};

const saveManualColumnWidths = (widths: Record<string, number>) => {
  try {
    localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Keep resizing available even when localStorage is unavailable.
  }
};

export default function CustomDocsTable({
  records,
  visibleColumns,
  linkRules,
  s3CatalogIndex,
  queryText,
  onAddSearchPhrase,
  selectedRowIds,
  onToggleRowSelection,
  onToggleAllRowsSelection,
  onClearAllSelections,
  onDownloadS3Archives,
  onExportEsZip,
  onExportCSV,
  onExportJSON,
}: CustomDocsTableProps) {
  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [manualColumnWidths, setManualColumnWidths] = useState<Record<string, number>>(readManualColumnWidths);
  const [sortConfig, setSortConfig] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);

  // Expanded Docs for Row details drawer
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(new Set());

  // Log Payload details download indicator status
  const [activeDownloadStatus, setActiveDownloadStatus] = useState<{
    fileName: string;
    url: string;
    show: boolean;
    counter: number;
  } | null>(null);

  // Copied row IDs feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const highlightTerms = useMemo(() => getSearchHighlightTerms(queryText), [queryText]);

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const renderHighlightedText = (value: unknown) => {
    const text = String(value ?? '');
    if (highlightTerms.length === 0 || text.length === 0) return text;

    const matcher = new RegExp(`(${highlightTerms.map(escapeRegExp).join('|')})`, 'gi');
    return text.split(matcher).map((part, index) => {
      if (!part) return null;
      const isMatch = highlightTerms.some((term) => term.toLowerCase() === part.toLowerCase());
      return isMatch ? (
        <mark key={`${part}-${index}`} className="rounded-sm bg-yellow-200 px-0.5 text-slate-950">
          {part}
        </mark>
      ) : (
        <Fragment key={`${part}-${index}`}>{part}</Fragment>
      );
    });
  };

  const toggleExpandDoc = (id: string) => {
    const next = new Set(expandedDocIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpandedDocIds(next);
  };

  const getSortValue = (record: LogRecord, column: string) => {
    return column === 'timestamp' ? record.timestamp : (record as unknown as Record<string, unknown>)[column];
  };

  const getComparableValue = (value: unknown) => {
    if (value == null || value === '') return { type: 'empty', value: '' };
    if (value instanceof Date) return { type: 'date', value: value.getTime() };
    if (typeof value === 'number') return { type: 'number', value };
    if (typeof value === 'string') {
      const trimmed = value.trim();
      const numericValue = Number(trimmed);
      if (trimmed !== '' && Number.isFinite(numericValue)) return { type: 'number', value: numericValue };
      const timestamp = Date.parse(trimmed);
      if (!Number.isNaN(timestamp) && /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|:\d{2}/.test(trimmed)) {
        return { type: 'date', value: timestamp };
      }
      return { type: 'text', value: trimmed.toLowerCase() };
    }
    return { type: 'text', value: String(value).toLowerCase() };
  };

  const sortedRecords = useMemo(() => {
    if (!sortConfig) return records;
    return [...records].sort((a, b) => {
      const aComparable = getComparableValue(getSortValue(a, sortConfig.column));
      const bComparable = getComparableValue(getSortValue(b, sortConfig.column));

      if (aComparable.type === 'empty' && bComparable.type !== 'empty') return 1;
      if (bComparable.type === 'empty' && aComparable.type !== 'empty') return -1;

      let result = 0;
      if (
        (aComparable.type === 'number' || aComparable.type === 'date') &&
        aComparable.type === bComparable.type
      ) {
        result = Number(aComparable.value) - Number(bComparable.value);
      } else {
        result = String(aComparable.value).localeCompare(String(bComparable.value));
      }
      return sortConfig.direction === 'asc' ? result : -result;
    });
  }, [records, sortConfig]);

  const handleSort = (column: string) => {
    setSortConfig((current) => {
      if (current?.column === column) {
        return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { column, direction: 'asc' };
    });
    setCurrentPage(1);
  };

  const renderSortIcon = (column: string) => {
    if (sortConfig?.column !== column) return <ArrowUpDown className="w-3 h-3 text-slate-400" />;
    return sortConfig.direction === 'asc'
      ? <ArrowUp className="w-3 h-3 text-[#006bb4]" />
      : <ArrowDown className="w-3 h-3 text-[#006bb4]" />;
  };

  const autoColumnWidths = useMemo(() => {
    const widths: Record<string, number> = {};
    const columns = ['timestamp', ...visibleColumns];

    columns.forEach((column) => {
      widths[column] = estimateColumnWidth(
        column === 'timestamp' ? 'Time' : column,
        records.map((record) => getDisplayValue(record, column)),
        column === 'timestamp' ? 190 : MIN_COLUMN_WIDTH
      );
    });

    return widths;
  }, [records, visibleColumns]);

  const getColumnWidth = (column: string) => manualColumnWidths[column] ?? autoColumnWidths[column] ?? MIN_COLUMN_WIDTH;

  const handleColumnResizeStart = (event: ReactMouseEvent<HTMLSpanElement>, column: string) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getColumnWidth(column);
    let latestWidth = startWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      latestWidth = clampColumnWidth(startWidth + moveEvent.clientX - startX);
      setManualColumnWidths((current) => ({ ...current, [column]: latestWidth }));
    };

    const handleUp = () => {
      setManualColumnWidths((current) => {
        const next = { ...current, [column]: latestWidth };
        saveManualColumnWidths(next);
        return next;
      });
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  };

  const renderSortableHeader = (column: string, label = column, className = '') => (
    <div className="relative h-full pr-2">
      <button
        type="button"
        onClick={() => handleSort(column)}
        className={`w-full flex items-center justify-between gap-2 text-left hover:text-[#006bb4] cursor-pointer ${className}`}
        title={`Sort by ${label}`}
      >
        <span className="truncate">{label}</span>
        {renderSortIcon(column)}
      </button>
      <span
        onMouseDown={(event) => handleColumnResizeStart(event, column)}
        className="absolute -right-3 top-[-10px] h-10 w-3 cursor-col-resize border-r border-transparent hover:border-[#006bb4]"
        title={`Resize ${label}`}
      />
    </div>
  );

  // Pagination calculation
  const totalPages = Math.ceil(sortedRecords.length / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedRecords = sortedRecords.slice(startIndex, startIndex + rowsPerPage);
  const currentPageIds = paginatedRecords.map(r => r._id);

  useEffect(() => {
    setCurrentPage((page) => Math.min(Math.max(1, page), totalPages));
  }, [totalPages]);

  // Is every item on current page selected?
  const isAllPageSelected = currentPageIds.length > 0 && currentPageIds.every(id => selectedRowIds.has(id));

  const pageOptions = useMemo(() => {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }, [totalPages]);

  const handleRowsPerPageChange = (nextRowsPerPage: number) => {
    setRowsPerPage(nextRowsPerPage);
    setCurrentPage(1);
  };

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId(null);
    }, 1800);
  };

  /**
   * Evaluates customizable URL templates replacing {value} mapping
   */
  const renderParameterizedCell = (columnName: string, value: any, record: LogRecord) => {
    const rule = linkRules.find(r => r.columnName === columnName);
    const isS3CatalogRecord = record._index === s3CatalogIndex;

    // Fallback: Default clickable handler for direct download_url column
    if (columnName === 'download_url' && !isS3CatalogRecord) {
      return <span className="text-slate-750 font-mono text-sm">{renderHighlightedText(value)}</span>;
    }

    if (columnName === 'download_url' && !rule) {
      return (
        <button
          onClick={() => triggerSingleLogDownload(record)}
          className="text-[#006bb4] hover:text-[#004e82] hover:underline font-mono text-sm font-medium flex items-center gap-1.5 transition-colors cursor-pointer text-left"
          title="Click to download individual payload package"
        >
          <Archive className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          <span className="truncate max-w-[200px]">{renderHighlightedText(value)}</span>
        </button>
      );
    }

    if (rule) {
      const valStr = String(value);
      const url = rule.urlTemplate.replace(/\{value\}/gi, encodeURIComponent(valStr));
      let label = rule.labelTemplate.replace(/\{value\}/gi, valStr);

      const themeColors = {
        default: 'text-slate-700 bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-800',
        blue: 'text-blue-700 bg-blue-50 hover:bg-blue-100 border-blue-200 text-blue-900',
        emerald: 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-900',
        amber: 'text-amber-700 bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-900',
        indigo: 'text-indigo-700 bg-indigo-50 hover:bg-indigo-150 border-indigo-200 text-indigo-900',
        rose: 'text-rose-700 bg-rose-50 hover:bg-rose-100 border-rose-200 text-rose-900',
      };

      const colorClass = themeColors[rule.colorScheme] || themeColors.blue;

      // Wrap links into high-contrast tags to make them distinct and functional
      return (
        <a
          href={url}
          target={rule.openInNewTab ? "_blank" : "_self"}
          rel="noopener noreferrer"
          onClick={(e) => {
            if (rule.urlTemplate === '{value}' || rule.urlTemplate === '') {
              e.preventDefault();
              // If it points directly to {value} and looks like the s3 url, triggers simulation
              if (columnName === 'download_url' || valStr.startsWith('http')) {
                triggerSingleLogDownload(record);
              }
            }
          }}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs font-mono leading-none transition-all duration-150 shadow-2xs ${colorClass}`}
          title={`Dynamic link custom destination: ${url}`}
        >
          <span className="truncate max-w-[200px]">{renderHighlightedText(label)}</span>
          <ExternalLink className="w-2.5 h-2.5 opacity-60" />
        </a>
      );
    }

    // Default column rendering is simple text output
    return <span className="text-slate-750 font-mono text-sm">{renderHighlightedText(value)}</span>;
  };

  /**
   * Stimulates downloading individual document raw metric bundle directly from application
   */
  const triggerSingleLogDownload = (record: LogRecord) => {
    if (record._index !== s3CatalogIndex) return;

    const s3Key = getS3KeyFromRecord(record);
    const downloadUrl = s3Key
      ? `/api/s3/proxy-download?key=${encodeURIComponent(s3Key)}`
      : record.download_url;

    setActiveDownloadStatus({
      fileName: record.archive_name || s3Key || 'archive',
      url: downloadUrl,
      show: true,
      counter: 0,
    });

    const timer = setInterval(() => {
      setActiveDownloadStatus((p) => {
        if (!p) {
          clearInterval(timer);
          return null;
        }
        if (p.counter >= 100) {
          clearInterval(timer);
          const anchor = document.createElement('a');
          anchor.href = downloadUrl;
          anchor.download = record.archive_name || (s3Key?.split('/').pop() ?? 'archive.zip');
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);

          setTimeout(() => setActiveDownloadStatus(null), 1500);
          return { ...p, counter: 100 };
        }
        return { ...p, counter: p.counter + 25 };
      });
    }, 120);
  };

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden p-4 gap-4" id="discover-datagrid">

      {/* Search Header Statistics & Page Info */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          <Terminal className="w-4 h-4 text-slate-500" />
          <span>Index Documents Results ({records.length} hits)</span>
          <span className="text-slate-400 font-normal">|</span>
          <span className="font-mono text-xs text-slate-500">
            Showing logs {sortedRecords.length > 0 ? startIndex + 1 : 0} to {Math.min(startIndex + rowsPerPage, sortedRecords.length)}
          </span>
        </div>

        {/* Page Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            Rows
            <select
              value={rowsPerPage}
              onChange={(event) => handleRowsPerPageChange(Number(event.target.value))}
              className="border border-slate-200 bg-white rounded px-2 py-1 text-xs font-mono text-slate-800 focus:outline-none focus:border-[#006bb4]"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
            </select>
          </label>
          <button
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={currentPage === 1}
            className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 font-medium transition-colors cursor-pointer"
          >
            ◀ Previous
          </button>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            Page
            <select
              value={currentPage}
              onChange={(event) => setCurrentPage(Number(event.target.value))}
              className="border border-slate-200 bg-white rounded px-2 py-1 text-xs font-mono text-slate-800 focus:outline-none focus:border-[#006bb4] min-w-16"
            >
              {pageOptions.map((page) => (
                <option key={page} value={page}>{page}</option>
              ))}
            </select>
            <span className="font-mono text-slate-500">/ {totalPages}</span>
          </label>
          <button
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={currentPage === totalPages}
            className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 font-medium transition-colors cursor-pointer"
          >
            Next ▶
          </button>
        </div>
      </div>

      {/* Main Grid Table wrapper */}
      <div className="flex-1 border border-slate-200 rounded-md overflow-hidden flex flex-col min-h-[300px] relative">
        <div className="flex-1 overflow-auto max-h-[580px]">
          <table className="w-full text-left border-collapse table-fixed select-text text-sm">
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: 48 }} />
              <col style={{ width: getColumnWidth('timestamp') }} />
              {visibleColumns.map((column) => (
                <col key={column} style={{ width: getColumnWidth(column) }} />
              ))}
            </colgroup>

            {/* Table Header Row */}
            <thead className="bg-slate-100 border-b border-slate-200 text-sm font-semibold text-slate-600 sticky top-0 z-10 shadow-3xs">
              <tr>
                {/* Expander Column */}
                <th className="py-3 px-3 text-center border-r border-slate-200"></th>

                {/* Global Row Selection */}
                <th className="py-3 px-3 text-center border-r border-[#e2e8f0]">
                  <input
                    type="checkbox"
                    checked={isAllPageSelected}
                    onChange={() => onToggleAllRowsSelection(currentPageIds)}
                    className="rounded border-slate-300 text-[#006bb4] focus:ring-[#006bb4] cursor-pointer"
                    title="Select/Deselect all rows on this page"
                  />
                </th>

                {/* Always-visible Time Column */}
                <th className="py-3 px-3 border-r border-slate-200 font-sans">
                  {renderSortableHeader('timestamp', 'Time')}
                </th>

                {/* Dynamically Toggled Columns */}
                {visibleColumns.map((column) => (
                  <th
                    key={column}
                    className="py-3 px-3 border-r border-slate-200 font-sans truncate"
                  >
                    {renderSortableHeader(column)}
                  </th>
                ))}
              </tr>
            </thead>

            {/* Table Body Content */}
            <tbody className="divide-y divide-slate-150 text-sm font-mono">
              {paginatedRecords.map((record) => {
                const isExpanded = expandedDocIds.has(record._id);
                const isSelected = selectedRowIds.has(record._id);
                const isS3CatalogRecord = record._index === s3CatalogIndex;

                // Color levels indicator matches classic Kibana log color edges
                const levelColorBar =
                  record.level === 'error' ? 'border-l-4 border-l-rose-500 bg-rose-50/20' :
                  record.level === 'warn' ? 'border-l-4 border-l-amber-500 bg-amber-50/20' :
                  'border-l-4 border-l-sky-500 bg-emerald-50/10';

                return (
                  <Fragment key={record._id}>
                    <tr
                      key={record._id}
                      className={`hover:bg-slate-50/75 transition-colors duration-75 ${levelColorBar} ${isSelected ? 'bg-blue-50/30' : ''}`}
                    >
                      {/* Accordion trigger details */}
                      <td className="py-2.5 text-center border-r border-slate-150">
                        <button
                          onClick={() => toggleExpandDoc(record._id)}
                          className="text-slate-500 hover:text-slate-800 transition-colors p-1 rounded hover:bg-slate-200 focus:outline-none cursor-pointer"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-700" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                          )}
                        </button>
                      </td>

                      {/* Row Checkbox Picker */}
                      <td className="py-2.5 text-center border-r border-slate-150">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleRowSelection(record._id)}
                          className="rounded border-slate-300 text-[#006bb4] focus:ring-[#006bb4] cursor-pointer"
                        />
                      </td>

                      {/* Hardcoded system timestamp representation */}
                      <td className="py-2.5 px-3 border-r border-slate-150 break-words whitespace-normal text-slate-500 font-sans font-medium text-sm">
                        {renderHighlightedText(formatTableTimestamp(record.timestamp))}
                      </td>

                      {/* Dynamically configured variable index contents */}
                      {visibleColumns.map((column) => {
                        const cellValue = (record as Record<string, unknown>)[column];

                        return (
                          <td
                            key={column}
                            className="py-2.5 px-3 border-r border-slate-150 text-sm truncate"
                          >
                            {renderParameterizedCell(column, cellValue, record)}
                          </td>
                        );
                      })}
                    </tr>

                    {/* Expandable Document details Drawer mimicking Kibana metadata view */}
                    {isExpanded && (
                      <tr key={`expanded-${record._id}`} className="bg-slate-50/80">
                        <td colSpan={visibleColumns.length + 3} className="py-4 px-6 border-b border-slate-200">
                          <div className="bg-white border border-slate-200 rounded-md shadow-inner flex flex-col p-4 gap-4">

                            {/* Inner Tab header tools */}
                            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                              <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5 font-sans">
                                <FileText className="w-4 h-4 text-[#006bb4]" />
                                JSON Document _source Details for record <span className="font-mono text-blue-700">{record._id}</span>
                              </span>

                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleCopyId(record._id)}
                                  className="text-xs text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                >
                                  {copiedId === record._id ? (
                                    <>
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                      Copied Document!
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3.5 h-3.5" />
                                      Copy Doc ID
                                    </>
                                  )}
                                </button>

                                <button
                                  onClick={() => onAddSearchPhrase(`_id:${record._id}`)}
                                  className="text-xs text-[#006bb4] bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2.5 py-1 rounded flex items-center gap-1 transition-colors cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" /> Filter by ID
                                </button>

                                {isS3CatalogRecord && (
                                  <button
                                    onClick={() => triggerSingleLogDownload(record)}
                                    className="text-xs text-white bg-slate-800 hover:bg-slate-900 px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                  >
                                    <Download className="w-3.5 h-3.5" /> Download Payload Bundle
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Two-Column split data preview */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {/* Grid key-value table */}
                              <div className="border border-slate-150 rounded bg-slate-50/20 max-h-72 overflow-y-auto">
                                <div className="divide-y divide-slate-150 text-xs">
                                  {Object.entries(record).map(([key, val]) => (
                                    <div key={key} className="flex px-3 py-1.5 hover:bg-slate-50">
                                      <span className="w-32 text-slate-500 font-semibold truncate shrink-0">{key}</span>
                                      <span className="text-slate-800 break-all select-all font-mono">
                                        {renderHighlightedText(typeof val === 'object' ? JSON.stringify(val) : String(val))}
                                      </span>

                                      {/* Quick search filters for metadata key values */}
                                      <button
                                        onClick={() => {
                                          const queryStr = typeof val === 'number' ? `${key}:${val}` : `${key}:${String(val)}`;
                                          onAddSearchPhrase(queryStr);
                                        }}
                                        className="ml-auto text-slate-300 hover:text-blue-600 transition-colors p-0.5"
                                        title={`Add query constraint ${key}:${val}`}
                                      >
                                        <Plus className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* Raw JSON formatted representation */}
                              <div className="bg-slate-900 rounded p-3 text-slate-300 font-mono text-[11px] max-h-72 overflow-y-auto border border-slate-950">
                                <pre className="whitespace-pre">{renderHighlightedText(JSON.stringify(record, null, 2))}</pre>
                              </div>
                            </div>

                            {/* Quick Link Tracing Guide Area */}
                            {isS3CatalogRecord && (
                              <div className="p-2.5 bg-sky-50 text-[#005a96] border border-sky-100 rounded text-xs flex items-center justify-between">
                                <a
                                  href={record.download_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline font-semibold hover:text-[#004e82] shrink-0"
                                >
                                  Download the file
                                </a>
                              </div>
                            )}

                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}

              {records.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length + 3} className="py-12 text-center text-slate-450 text-xs">
                    <AlertCircle className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                    No documents matched search filters. Refine query text or adjust time picker intervals.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Floating Bulk Actions Bar (Activates upon checked logs) */}
      {selectedRowIds.size > 0 && (
        <div className="bg-slate-900 border border-slate-800 text-white rounded-lg p-3.5 shadow-xl flex flex-col sm:flex-row items-center justify-between gap-3 anim-fade-in z-20" id="floating-actions">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-6 h-6 bg-[#006bb4] text-white rounded-full text-xs font-bold font-mono">
              {selectedRowIds.size}
            </span>
            <div>
              <span className="text-xs font-semibold text-slate-100 block">
                Selected Row Documents
              </span>
              <span className="text-[10px] text-[#00a9e5] font-mono block">
                Download S3 archives or export Elasticsearch documents
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Download actual S3/MinIO zip archives */}
            {[...selectedRowIds].every((id) => records.some((record) => record._id === id && record._index === s3CatalogIndex)) && (
              <button
                onClick={onDownloadS3Archives}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Download zip archives from S3/MinIO for selected rows"
              >
                <Archive className="w-3.5 h-3.5 shrink-0" />
                Download S3 Archives (ZIP)
              </button>
            )}

            <div className="h-6 w-px bg-slate-700 mx-1 hidden sm:block" />

            <span className="text-[10px] text-slate-500 uppercase tracking-wide hidden sm:inline">Export ES data</span>

            <button
              onClick={onExportEsZip}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Export selected Elasticsearch documents as ZIP (JSON + CSV)"
            >
              <Archive className="w-3.5 h-3.5 text-violet-400 shrink-0" />
              Export Documents (ZIP)
            </button>

            <button
              onClick={onExportCSV}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Export selected rows as CSV"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              Export CSV
            </button>

            <button
              onClick={onExportJSON}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Export selected rows as JSON"
            >
              <FileText className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              Export JSON
            </button>

            <div className="h-6 w-px bg-slate-700 mx-1 hidden sm:block" />

            {/* Reset button */}
            <button
              onClick={onClearAllSelections}
              className="text-xs hover:text-white text-slate-400 font-medium hover:underline px-2.5 py-1 transition-colors cursor-pointer"
            >
              Deselect All
            </button>
          </div>
        </div>
      )}

      {/* Progress Simulator Overlay for Single Downloads */}
      {activeDownloadStatus?.show && (
        <div className="fixed inset-0 bg-black/65 flex items-center justify-center z-55 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 max-w-sm w-full mx-4 shadow-2xl text-white text-center flex flex-col items-center gap-4 animate-in fade-in duration-200">
            <Archive className="w-12 h-12 text-[#00a9e5] animate-bounce" />

            <div className="space-y-1">
              <span className="text-sm font-semibold block">Downloading Single Archive Payload</span>
              <span className="font-mono text-[11px] text-[#38bdf8] block truncate leading-none max-w-xs p-1">
                {activeDownloadStatus.fileName}
              </span>
            </div>

            {/* Status meter */}
            <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden border border-slate-700 mt-1">
              <div
                className="bg-[#006bb4] h-full transition-all duration-100 ease-out"
                style={{ width: `${activeDownloadStatus.counter}%` }}
              />
            </div>

            <span className="text-[10px] text-slate-400 font-mono">
              Target Link: {activeDownloadStatus.url}
            </span>

            {activeDownloadStatus.counter === 100 && (
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                <FileCheck className="w-4 h-4" /> Download Complete!
              </span>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
