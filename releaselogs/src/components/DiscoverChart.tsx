/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { LogRecord } from '../types';

interface DiscoverChartProps {
  filteredRecords: LogRecord[];
}

interface BucketData {
  timeLabel: string;
  info: number;
  warn: number;
  error: number;
  total: number;
}

export default function DiscoverChart({ filteredRecords }: DiscoverChartProps) {
  const chartData = useMemo(() => {
    if (filteredRecords.length === 0) return [];

    // Let's create about 12 dynamic buckets based on the actual range of filteredRecords
    const sorted = [...filteredRecords].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const minTime = new Date(sorted[0].timestamp).getTime();
    const maxTime = new Date(sorted[sorted.length - 1].timestamp).getTime();
    const range = maxTime - minTime;

    // Default to a 24-hour range if time range is tiny
    const bucketCount = 12;
    const interval = range > 1000 ? range / bucketCount : 3600000; // 1 hour default

    const buckets: { start: number; end: number; info: number; warn: number; error: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const start = minTime + i * interval;
      buckets.push({
        start,
        end: start + interval,
        info: 0,
        warn: 0,
        error: 0,
      });
    }

    // Populate buckets
    for (const record of sorted) {
      const recTime = new Date(record.timestamp).getTime();
      let placed = false;
      for (let i = 0; i < buckets.length; i++) {
        if (recTime >= buckets[i].start && recTime < buckets[i].end) {
          buckets[i][record.level]++;
          placed = true;
          break;
        }
      }
      // Put in last bucket as fallback
      if (!placed && buckets.length > 0) {
        buckets[buckets.length - 1][record.level]++;
      }
    }

    // Format bucket data labels
    return buckets.map((bucket, idx) => {
      const startD = new Date(bucket.start);
      // Format as e.g. "05-25 01:20" or just "01:20:00" if same day
      const timeLabel = startD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return {
        timeLabel,
        info: bucket.info,
        warn: bucket.warn,
        error: bucket.error,
        total: bucket.info + bucket.warn + bucket.error,
      };
    });
  }, [filteredRecords]);

  if (filteredRecords.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center border border-slate-200 bg-slate-50 rounded-sm text-xs text-slate-400 font-sans">
        No log metadata in target time window to display chart.
      </div>
    );
  }

  return (
    <div className="border border-slate-200 bg-white rounded-md p-3 shadow-2xs flex flex-col gap-1.5" id="records-histogram">
      <div className="flex items-center justify-between text-xs font-semibold text-slate-600 px-1">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          Hits Over Time Bucket (Grouped by Level)
        </span>
        <span className="text-[10px] text-slate-400 uppercase font-mono">
          Interactive Histogram | {filteredRecords.length} docs
        </span>
      </div>

      <div className="w-full h-36 mt-1 flex">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 5, right: 10, left: -25, bottom: 0 }}
            barGap={0}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis 
              dataKey="timeLabel" 
              tick={{ fill: '#94a3b8', fontSize: 9, fontFamily: 'monospace' }}
              stroke="#e2e8f0"
              dy={5}
            />
            <YAxis 
              tick={{ fill: '#94a3b8', fontSize: 9 }}
              stroke="#e2e8f0"
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: 'none', borderRadius: '4px', color: '#fff' }}
              labelStyle={{ fontSize: 10, fontWeight: 'bold', fontFamily: 'monospace', color: '#38bdf8' }}
              itemStyle={{ fontSize: 11 }}
            />
            <Bar dataKey="info" stackId="a" fill="#006bb4" name="Info level" radius={[0, 0, 0, 0]} />
            <Bar dataKey="warn" stackId="a" fill="#eab308" name="Warn level" radius={[0, 0, 0, 0]} />
            <Bar dataKey="error" stackId="a" fill="#f43f5e" name="Error level" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
