/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, FormEvent } from 'react';
import { Search, Clock, RefreshCw, Calendar, ChevronDown, Check, Settings, LogOut, User as UserIcon } from 'lucide-react';
import { QueryFilter, User } from '../types';
import ingLogo from './ING_logo.svg';

interface KibanaHeaderProps {
  filter: QueryFilter;
  onChangeFilter: (newFilter: QueryFilter) => void;
  onRefreshData: () => void;
  totalAvailable: number;
  filteredCount: number;
  isRefreshing: boolean;
  currentUser: User;
  onLogout: () => void;
  onNavigateToAdmin?: () => void;
}

const TIMESTAMP_PRESETS = [
  { label: 'Last 15 minutes', minutes: 15 },
  { label: 'Last 1 hour', minutes: 60 },
  { label: 'Last 4 hours', minutes: 240 },
  { label: 'Last 12 hours', minutes: 720 },
  { label: 'Last 24 hours', minutes: 1440 },
  { label: 'Last 7 days', minutes: 10080 },
  { label: 'Last 14 days', minutes: 20160 },
  { label: 'Last 30 days', minutes: 43200 },
  { label: 'Last 90 days', minutes: 129600 },
  { label: 'Last 6 months', minutes: 262800 },
  { label: 'Last 1 year', minutes: 525600 },
  { label: 'Last 2 years', minutes: 1051200 },
  { label: 'Last 5 years', minutes: 2628000 },
  { label: 'All available', minutes: 0 },
];

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getDefaultCustomFrom(): string {
  return toDateTimeLocal(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
}

function getCustomInputValue(value: string, fallback: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() <= 1970) return fallback;
  return toDateTimeLocal(value);
}

export default function KibanaHeader({
  filter,
  onChangeFilter,
  onRefreshData,
  totalAvailable,
  filteredCount,
  isRefreshing,
  currentUser,
  onLogout,
  onNavigateToAdmin,
}: KibanaHeaderProps) {
  const [tempQueryText, setTempQueryText] = useState(filter.queryText);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [customFrom, setCustomFrom] = useState(() =>
    getCustomInputValue(filter.timestampRange.from, getDefaultCustomFrom())
  );
  const [customTo, setCustomTo] = useState(() =>
    getCustomInputValue(filter.timestampRange.to, toDateTimeLocal(new Date().toISOString()))
  );
  const [customTimeError, setCustomTimeError] = useState<string | null>(null);

  useEffect(() => {
    setTempQueryText(filter.queryText);
  }, [filter.queryText]);

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    onChangeFilter({
      ...filter,
      queryText: tempQueryText,
    });
  };

  const selectPreset = (label: string, minutes: number) => {
    const toDate = new Date();
    let fromDateStr = '';

    if (minutes > 0) {
      const fromDate = new Date(toDate.getTime() - minutes * 60 * 1000);
      fromDateStr = fromDate.toISOString();
    } else {
      fromDateStr = '1970-01-01T00:00:00Z';
    }

    onChangeFilter({
      ...filter,
      timestampRange: {
        from: fromDateStr,
        to: toDate.toISOString(),
        label,
      },
    });
    setCustomFrom(getCustomInputValue(fromDateStr, getDefaultCustomFrom()));
    setCustomTo(toDateTimeLocal(toDate.toISOString()));
    setCustomTimeError(null);
    setShowTimePicker(false);
  };

  const applyCustomRange = () => {
    setCustomTimeError(null);
    const fromDate = customFrom ? new Date(customFrom) : null;
    const toDate = customTo ? new Date(customTo) : null;

    if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      setCustomTimeError('Select both start and end date.');
      return;
    }
    if (fromDate.getTime() > toDate.getTime()) {
      setCustomTimeError('Start must be before end.');
      return;
    }

    onChangeFilter({
      ...filter,
      timestampRange: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        label: 'Custom range',
      },
    });
    setShowTimePicker(false);
  };

  return (
    <header className="bg-slate-900 text-white min-h-[56px] border-b border-slate-700 flex flex-col justify-between shrink-0" id="kibana-header">
      <div className="flex flex-col sm:flex-row items-center justify-between px-4 py-2 border-b border-slate-800 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <img src={ingLogo} alt="ING" className="h-7 w-7 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span className="font-bold tracking-wider text-sm text-white uppercase font-sans">
              RELEASE LOGS
            </span>
            <span className="text-xs text-[#00a9e5] font-light font-mono tracking-tight uppercase">
              AZURE DEVOPS
            </span>
          </div>

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

        <div className="flex flex-wrap items-center gap-3 sm:gap-5 text-xs text-slate-350">

          {onNavigateToAdmin && (
            <button
              onClick={onNavigateToAdmin}
              className="text-[11px] bg-[#006bb4] hover:bg-[#005a96] text-white px-3 py-1.5 rounded transition-all font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs border border-[#005a96]"
              title="Administrator — LDAP, Elasticsearch, S3 storage, audit logs"
            >
              <Settings className="w-3.5 h-3.5" />
              Administrator
            </button>
          )}

          <button
            onClick={onLogout}
            className="text-[11px] bg-slate-850 hover:bg-slate-800 hover:text-white text-slate-300 px-2 py-1.5 rounded transition-colors flex items-center gap-1 cursor-pointer border border-slate-755"
            title="Log Out"
          >
            <LogOut className="w-3 h-3" />
            Log Out
          </button>
        </div>
      </div>

      <div className="p-3 bg-slate-850 flex items-center gap-3">
        <form onSubmit={handleSearchSubmit} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-2.5 text-slate-400">
              <Search className="w-4 h-4" />
            </span>
            <input
              type="text"
              value={tempQueryText}
              onChange={(e) => setTempQueryText(e.target.value)}
              placeholder="Search text or filters, e.g. level:info and ip:10.0.0.2"
              className="w-full text-xs bg-slate-800 border border-slate-700 text-white pl-9 pr-32 py-2 rounded focus:outline-none focus:border-[#006bb4] focus:ring-1 focus:ring-[#006bb4] placeholder-slate-500 font-mono tracking-wide"
            />
            {tempQueryText && (
              <button
                type="button"
                onClick={() => {
                  setTempQueryText('');
                  onChangeFilter({ ...filter, queryText: '' });
                }}
                className="absolute right-20 top-2 text-xs text-slate-400 hover:text-white font-mono bg-slate-750 px-1 py-0.5 rounded cursor-pointer"
              >
                clear
              </button>
            )}
            <button
              type="submit"
              className="absolute right-2 top-2 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-0.5 rounded transition-colors uppercase font-mono cursor-pointer"
            >
              Search
            </button>
          </div>
        </form>

        <div className="relative">
          <button
            onClick={() => setShowTimePicker(!showTimePicker)}
            className="bg-slate-800 hover:bg-slate-705 border border-slate-700 text-slate-100 px-3.5 py-2 rounded text-xs leading-none flex items-center gap-2 transition-colors duration-150 cursor-pointer"
          >
            <Clock className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span className="font-medium font-sans">Time range:</span>
            <span className="font-mono text-yellow-400">{filter.timestampRange.label}</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-1" />
          </button>

          {showTimePicker && (
            <div className="absolute right-0 top-11 z-50 w-80 bg-white rounded shadow-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden text-slate-800 animate-in fade-in zoom-in-95 duration-100">
              <div className="p-3 bg-slate-50 font-semibold text-xs text-slate-500 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-600" />
                Select time range
              </div>
              <div className="grid grid-cols-2 py-1">
                {TIMESTAMP_PRESETS.map((preset) => {
                  const isActive = filter.timestampRange.label === preset.label;
                  return (
                    <button
                      key={preset.label}
                      onClick={() => selectPreset(preset.label, preset.minutes)}
                      className="w-full text-left py-2 px-4 text-xs font-medium text-slate-700 hover:bg-[#006bb4] hover:text-white transition-colors duration-100 flex items-center justify-between cursor-pointer"
                    >
                      <span>{preset.label}</span>
                      {isActive && <Check className="w-3 h-3 text-[#006bb4]" />}
                    </button>
                  );
                })}
              </div>
              <div className="p-3 bg-slate-50 space-y-2">
                <div className="text-[11px] font-bold uppercase text-slate-500">Custom range</div>
                <div className="grid grid-cols-1 gap-2">
                  <label className="text-[10px] font-semibold uppercase text-slate-500">
                    From
                    <input
                      type="datetime-local"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-[#006bb4]"
                    />
                  </label>
                  <label className="text-[10px] font-semibold uppercase text-slate-500">
                    To
                    <input
                      type="datetime-local"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-[#006bb4]"
                    />
                  </label>
                </div>
                {customTimeError && (
                  <div className="text-[11px] text-rose-600 font-semibold">{customTimeError}</div>
                )}
                <button
                  type="button"
                  onClick={applyCustomRange}
                  className="w-full rounded bg-[#006bb4] hover:bg-[#005a96] px-3 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
                >
                  Apply custom range
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onRefreshData}
          disabled={isRefreshing}
          className="bg-slate-800 hover:bg-slate-700 border border-slate-700 p-2 text-slate-100 rounded text-xs flex items-center justify-center transition-colors shrink-0 disabled:opacity-50 cursor-pointer"
          title="Refresh data"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </header>
  );
}
