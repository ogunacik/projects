/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Database, Plus, Trash2, Link, ListFilter, PanelLeftClose } from 'lucide-react';
import { IndexPattern, LinkRule } from '../types';

interface KibanaSidebarProps {
  indexPatterns: IndexPattern[];
  selectedIndexPattern: IndexPattern | null;
  onSelectIndexPattern: (pattern: IndexPattern) => void;
  availableFields: string[];
  visibleColumns: string[];
  onToggleColumn: (field: string) => void;
  onClearVisibleColumns: () => void;
  linkRules: LinkRule[];
  onAddLinkRule: (rule: LinkRule) => void;
  onDeleteLinkRule: (columnName: string) => void;
  /** When false, index picker and admin-only sidebar tools are hidden */
  isAdmin?: boolean;
  width: number;
  onClose: () => void;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export default function KibanaSidebar({
  indexPatterns,
  selectedIndexPattern,
  onSelectIndexPattern,
  availableFields,
  visibleColumns,
  onToggleColumn,
  onClearVisibleColumns,
  linkRules,
  onAddLinkRule,
  onDeleteLinkRule,
  isAdmin = true,
  width,
  onClose,
  onResizeStart,
}: KibanaSidebarProps) {
  const [activeTab, setActiveTab] = useState<'fields' | 'links'>('fields');
  const [fieldSearch, setFieldSearch] = useState('');

  // Link Rule builder state
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [newRuleField, setNewRuleField] = useState('ip');
  const [newRuleTemplate, setNewRuleTemplate] = useState('https://ipinfo.io/{value}');
  const [newRuleLabel, setNewRuleLabel] = useState('GeoIP: {value}');
  const [newRuleNewTab, setNewRuleNewTab] = useState(true);
  const [newRuleColor, setNewRuleColor] = useState<LinkRule['colorScheme']>('blue');

  const [isIndexPatternVisible, setIsIndexPatternVisible] = useState(true);

  // Filter available fields based on search
  const filteredFields = availableFields.filter(f =>
    f.toLowerCase().includes(fieldSearch.toLowerCase())
  );

  const handleCreateRule = (e: FormEvent) => {
    e.preventDefault();
    if (!newRuleField) return;

    onAddLinkRule({
      columnName: newRuleField,
      urlTemplate: newRuleTemplate || '{value}',
      labelTemplate: newRuleLabel || '{value}',
      openInNewTab: newRuleNewTab,
      colorScheme: newRuleColor
    });

    // reset form
    setShowRuleForm(false);
  };

  const loadPresetRule = (type: 'geoip' | 'trace' | 'mock_archive') => {
    if (type === 'geoip') {
      setNewRuleField('ip');
      setNewRuleTemplate('https://ipinfo.io/{value}');
      setNewRuleLabel('Whois Check: {value}');
      setNewRuleColor('blue');
    } else if (type === 'trace') {
      setNewRuleField('request_path');
      setNewRuleTemplate('https://my-apm-tracing.local/traces?path={value}');
      setNewRuleLabel('Trace API: {value}');
      setNewRuleColor('emerald');
    } else if (type === 'mock_archive') {
      setNewRuleField('download_url');
      setNewRuleTemplate('{value}');
      setNewRuleLabel('Download File 🌐');
      setNewRuleColor('indigo');
    }
  };

  return (
    <aside
      className="relative border-r border-slate-200 bg-slate-50 flex flex-col h-full shrink-0"
      id="kibana-sidebar"
      style={{ width }}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 shadow-xs transition-colors hover:border-slate-300 hover:text-slate-800 cursor-pointer"
        title="Close index pattern sidebar"
      >
        <PanelLeftClose className="h-3.5 w-3.5" />
      </button>

      {/* Index Pattern Header */}
      <div className="p-4 pr-11 border-b border-slate-200 bg-white">
        <label
          className="flex items-center justify-between block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 cursor-pointer transition-colors hover:text-slate-700"
          onClick={() => setIsIndexPatternVisible(!isIndexPatternVisible)}
        >
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-[#006bb4]" />
            Elasticsearch Index
          </div>
          <span className="text-slate-400">
            {isIndexPatternVisible ? '▼' : '►'}
          </span>
        </label>

        {isIndexPatternVisible && (
          <>
            {isAdmin ? (
              <select
                value={selectedIndexPattern?.name || ''}
                onChange={(e) => {
                  const selected = indexPatterns.find(p => p.name === e.target.value);
                  if (selected) onSelectIndexPattern(selected);
                }}
                className="w-full text-sm font-medium border border-slate-200 bg-slate-50 text-slate-800 rounded-md py-1.5 px-3 focus:outline-none focus:border-[#006bb4] focus:ring-1 focus:ring-[#006bb4] transition-colors cursor-pointer"
              >
                {indexPatterns.map((pattern) => (
                  <option key={pattern.name} value={pattern.name}>
                    {pattern.name}
                  </option>
                ))}
                {indexPatterns.length === 0 && (
                  <option value="">No Elasticsearch indices</option>
                )}
              </select>
            ) : (
              <div className="w-full text-sm font-mono font-semibold border border-slate-200 bg-slate-100 text-slate-800 rounded-md py-2 px-3">
                {selectedIndexPattern?.name || 'No Elasticsearch index assigned'}
              </div>
            )}

            <p className="mt-1.5 text-xs text-slate-500 line-clamp-2 leading-relaxed">
              {isAdmin ? selectedIndexPattern?.description || 'Indices are loaded directly from Elasticsearch.' : 'Assigned index for your viewer session.'}
            </p>

          </>
        )}
      </div>

      <div
        onMouseDown={onResizeStart}
        className="absolute right-[-4px] top-0 z-20 h-full w-2 cursor-col-resize transition-colors hover:bg-[#006bb4]/20"
        title="Resize index pattern sidebar"
      />

      {/* Sidebar Tabs */}
      <div className="flex border-b border-slate-200 bg-slate-100 text-xs font-medium">
        <button
          onClick={() => setActiveTab('fields')}
          className={`flex-1 py-3 text-center border-b-2 font-semibold transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'fields'
              ? 'border-[#006bb4] text-[#006bb4] bg-white shadow-xs'
              : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <ListFilter className="w-3.5 h-3.5" />
          Fields ({availableFields.length})
        </button>
        {isAdmin && (
          <button
            onClick={() => setActiveTab('links')}
            className={`flex-1 py-3 text-center border-b-2 font-semibold transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'links'
                ? 'border-[#006bb4] text-[#006bb4] bg-white shadow-xs'
                : 'border-transparent text-slate-600 hover:text-[#000] hover:bg-slate-50'
            }`}
          >
            <Link className="w-3.5 h-3.5" />
            Link Rules ({linkRules.length})
          </button>
        )}
      </div>

      {/* Tab Panels */}
      <div className="flex-1 overflow-y-auto flex flex-col p-4">
        {activeTab === 'fields' ? (
          <div className="flex-col h-full flex gap-3">
            {/* Field Search */}
            <div className="relative">
              <input
                type="text"
                placeholder="Search index fields..."
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
                className="w-full text-xs bg-white border border-slate-200 text-slate-800 py-1.5 pl-3 pr-8 rounded-md focus:outline-none focus:border-[#006bb4]"
              />
              {fieldSearch && (
                <button
                  onClick={() => setFieldSearch('')}
                  className="absolute right-2.5 top-2 text-xs text-slate-400 hover:text-slate-600 font-bold"
                >
                  ×
                </button>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500 font-mono">
                {visibleColumns.length} selected
              </span>
              <button
                type="button"
                onClick={onClearVisibleColumns}
                disabled={visibleColumns.length === 0}
                className="inline-flex items-center gap-1 text-slate-500 hover:text-rose-600 disabled:opacity-40 disabled:hover:text-slate-500 cursor-pointer disabled:cursor-not-allowed font-semibold"
              >
                <Trash2 className="w-3 h-3" />
                Clear selection
              </button>
            </div>

            {/* Fields Checkbox List */}
            <div className="flex-1 border border-slate-200 bg-white rounded-md overflow-y-auto max-h-[480px]">
              <div className="p-1.5 divide-y divide-slate-100">
                {filteredFields.map((field) => {
                  const isVisible = visibleColumns.includes(field);
                  const isSpecial = ['timestamp', '_id', '_index'].includes(field);
                  return (
                    <label
                      key={field}
                      className="flex items-center gap-2.5 py-1.5 px-2 hover:bg-slate-50 rounded-xs cursor-pointer text-xs font-mono transition-colors text-slate-700"
                    >
                      <input
                        type="checkbox"
                        checked={isVisible}
                        disabled={isSpecial && field === 'timestamp'} // timestamp must always be visible
                        onChange={() => onToggleColumn(field)}
                        className="rounded border-slate-300 text-[#006bb4] focus:ring-[#006bb4] cursor-pointer"
                      />
                      <span className="flex-1 truncate">{field}</span>
                      {isSpecial && (
                        <span className="text-[10px] px-1 bg-slate-100 text-slate-500 rounded font-sans">
                          Sys
                        </span>
                      )}
                    </label>
                  );
                })}
                {filteredFields.length === 0 && (
                  <div className="p-4 text-center text-xs text-slate-400 font-sans">
                    No matching fields found
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Header and Add Button */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-600 block">
                Active Cell Link Rules
              </span>
              {!showRuleForm && (
                <button
                  onClick={() => setShowRuleForm(true)}
                  className="text-xs font-medium text-[#006bb4] hover:text-[#004e82] flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Add rule
                </button>
              )}
            </div>

            {/* Rule Configurator Form */}
            {showRuleForm && (
              <form onSubmit={handleCreateRule} className="p-3 bg-white border border-slate-200 rounded-md flex flex-col gap-3 shadow-xs">
                <div className="flex justify-between items-center pb-1 border-b border-slate-100">
                  <span className="text-xs font-bold text-slate-700">Configure Dynamic Link</span>
                  <button
                    type="button"
                    onClick={() => setShowRuleForm(false)}
                    className="text-slate-400 hover:text-slate-600 text-sm font-bold"
                  >
                    ×
                  </button>
                </div>

                {/* Micro Presets Quick Fill */}
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Load Preset</label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => loadPresetRule('geoip')}
                      className="text-[10px] bg-slate-100 hover:bg-blue-100 px-1.5 py-0.5 rounded text-slate-700 transition-colors"
                    >
                      IP Lookup
                    </button>
                    <button
                      type="button"
                      onClick={() => loadPresetRule('trace')}
                      className="text-[10px] bg-slate-100 hover:bg-emerald-100 px-1.5 py-0.5 rounded text-slate-700 transition-colors"
                    >
                      Trace Link
                    </button>
                    <button
                      type="button"
                      onClick={() => loadPresetRule('mock_archive')}
                      className="text-[10px] bg-slate-100 hover:bg-purple-100 px-1.5 py-0.5 rounded text-slate-700 transition-colors"
                    >
                      Raw URL
                    </button>
                  </div>
                </div>

                {/* Target Column Selection */}
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase mb-1">Target Field / Column</label>
                  <select
                    value={newRuleField}
                    onChange={(e) => setNewRuleField(e.target.value)}
                    className="w-full text-xs border border-slate-200 bg-slate-50 rounded p-1"
                  >
                    {availableFields.map(field => (
                      <option key={field} value={field}>{field}</option>
                    ))}
                  </select>
                </div>

                {/* URL Template */}
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase mb-1 flex items-center justify-between">
                    <span>URL Template</span>
                    <span className="font-mono text-[9px] text-[#006bb4] lowercase">{`{value}`} is replaced</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="https://ipinfo.io/{value}"
                    value={newRuleTemplate}
                    onChange={(e) => setNewRuleTemplate(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded p-1 font-mono"
                  />
                </div>

                {/* Label Template */}
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase mb-1">Label Mode / Template</label>
                  <input
                    type="text"
                    required
                    placeholder="Check geoip: {value}"
                    value={newRuleLabel}
                    onChange={(e) => setNewRuleLabel(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded p-1 font-mono"
                  />
                </div>

                {/* Color Scheme */}
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase mb-1">Visual Theme</label>
                  <div className="grid grid-cols-6 gap-1">
                    {(['default', 'blue', 'emerald', 'amber', 'indigo', 'rose'] as const).map((color) => {
                      const colorMap = {
                        default: 'bg-slate-500',
                        blue: 'bg-blue-500',
                        emerald: 'bg-emerald-500',
                        amber: 'bg-amber-500',
                        indigo: 'bg-indigo-500',
                        rose: 'bg-rose-500',
                      };
                      return (
                        <button
                          key={color}
                          type="button"
                          onClick={() => setNewRuleColor(color)}
                          className={`h-4 rounded border ${colorMap[color]} ${
                            newRuleColor === color ? 'ring-2 ring-slate-800 border-white' : 'border-transparent'
                          } cursor-pointer`}
                          title={color}
                        />
                      );
                    })}
                  </div>
                </div>

                {/* Target open style */}
                <label className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-700">
                  <input
                    type="checkbox"
                    checked={newRuleNewTab}
                    onChange={(e) => setNewRuleNewTab(e.target.checked)}
                    className="rounded border-slate-300 text-[#006bb4] focus:ring-[#006bb4]"
                  />
                  <span>Open URL in a new window</span>
                </label>

                <button
                  type="submit"
                  className="w-full bg-[#006bb4] hover:bg-[#005a96] text-white text-xs font-medium py-1.5 rounded transition-colors uppercase tracking-wider text-center cursor-pointer"
                >
                  Apply Link Rule
                </button>
              </form>
            )}

            {/* List of active rules */}
            <div className="flex flex-col gap-2.5">
              {linkRules.map((rule) => (
                <div key={rule.columnName} className="p-3 bg-white border border-slate-200 rounded-md relative group shadow-2xs hover:border-[#006bb4] transition-colors">
                  <div className="flex justify-between items-start mb-1 pr-6">
                    <span className="text-xs font-mono font-bold text-slate-800 p-0.5 bg-slate-100 rounded">
                      {rule.columnName}
                    </span>
                    <button
                      onClick={() => onDeleteLinkRule(rule.columnName)}
                      className="text-slate-400 hover:text-rose-600 transition-colors"
                      title="Remove field link rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-[11px] text-slate-550 break-all space-y-1">
                    <div>
                      <span className="text-slate-400 font-mono text-[10px]">URL:</span> {rule.urlTemplate}
                    </div>
                    <div>
                      <span className="text-slate-400 font-mono text-[10px]">Label:</span> {rule.labelTemplate}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[9px] text-slate-400">
                      {rule.openInNewTab ? 'New document tab' : 'Same tab'}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.2 rounded-full capitalize ${
                      rule.colorScheme === 'blue' ? 'bg-blue-50 text-blue-600 border border-blue-100' :
                      rule.colorScheme === 'emerald' ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' :
                      rule.colorScheme === 'amber' ? 'bg-amber-50 text-amber-600 border border-amber-100' :
                      rule.colorScheme === 'indigo' ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' :
                      rule.colorScheme === 'rose' ? 'bg-rose-50 text-rose-600 border border-rose-100' :
                      'bg-slate-100 text-slate-600 border border-slate-200'
                    }`}>
                      {rule.colorScheme} theme
                    </span>
                  </div>
                </div>
              ))}

              {linkRules.length === 0 && (
                <div className="p-6 text-center border-2 border-dashed border-slate-200 rounded-md text-slate-450 text-xs">
                  <Link className="w-6 h-6 mx-auto text-slate-350 mb-1.5" />
                  No link rules defined. By default, cells display static text. Add rules to customize link styling or map lookup redirects.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
