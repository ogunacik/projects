/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LogRecord } from '../types';
import JSZip from 'jszip';

/**
 * Triggers a web browser download of a text blob
 */
export function downloadBlob(content: string | Blob, filename: string, contentType: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Resolve the MinIO/S3 object key from an Elasticsearch document */
export function getS3KeyFromRecord(record: LogRecord): string | null {
  if (record.s3_key) return record.s3_key;
  if (record.download_url) {
    try {
      const parsed = new URL(record.download_url, window.location.origin);
      const key = parsed.searchParams.get('key');
      if (key) return decodeURIComponent(key);
    } catch {
      const match = record.download_url.match(/[?&]key=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  }
  if (record.archive_name) return record.archive_name;
  return null;
}

/**
 * Download actual S3/MinIO zip archives for selected rows (server bundles them)
 */
export async function downloadS3ArchivesBulk(
  records: LogRecord[],
  username?: string
): Promise<{ success: true } | { success: false; error: string }> {
  if (records.length === 0) {
    return { success: false, error: 'Select at least one document to download.' };
  }

  const keys = [
    ...new Set(
      records.map(getS3KeyFromRecord).filter((k): k is string => Boolean(k))
    ),
  ];

  if (keys.length === 0) {
    console.warn('No S3 keys found on selected documents');
    return { success: false, error: 'Selected rows are missing s3_key, download_url, and archive_name.' };
  }

  try {
    const res = await fetch('/api/s3/bulk-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, username }),
    });

    if (!res.ok) {
      const body = await res.text();
      let message = body || `S3 bulk download failed with HTTP ${res.status}.`;
      try {
        const parsed = JSON.parse(body);
        message = parsed.error || parsed.message || message;
      } catch {}
      console.error('S3 bulk download failed:', message);
      return { success: false, error: message };
    }

    const blob = await res.blob();
    const timestampStr = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `s3_archives_${timestampStr}.zip`, 'application/zip');
    return { success: true };
  } catch (err) {
    console.error('S3 bulk download request failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'S3 bulk download request failed.',
    };
  }
}

/**
 * Convert selected Log records to CSV
 */
export function convertToCSV(records: LogRecord[]): string {
  if (records.length === 0) return '';

  const headers = [
    'id',
    'index',
    'timestamp',
    'level',
    'method',
    'status',
    'request_path',
    'ip',
    'bytes',
    'country',
    'user_agent',
    'archive_name',
    's3_key',
    'download_url',
    'description',
  ];

  const csvRows = [headers.join(',')];

  for (const record of records) {
    const values = [
      record._id,
      record._index,
      record.timestamp,
      record.level,
      record.method,
      record.status,
      record.request_path,
      `"${record.ip}"`,
      record.bytes,
      record.country,
      `"${record.user_agent.replace(/"/g, '""')}"`,
      record.archive_name,
      record.s3_key ?? '',
      `"${record.download_url}"`,
      `"${(record.description ?? '').replace(/"/g, '""')}"`,
    ];
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

/**
 * Convert selected logs to JSON representation
 */
export function convertToJSON(records: LogRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/**
 * Export Elasticsearch document metadata (not S3 payloads) as a ZIP
 */
export async function exportElasticsearchDocumentsZip(
  records: LogRecord[],
  zipFilename: string
): Promise<boolean> {
  if (records.length === 0) return false;

  const zip = new JSZip();

  const meta = {
    exportedAt: new Date().toISOString(),
    totalDocuments: records.length,
    indicesIncluded: Array.from(new Set(records.map((r) => r._index))),
    records: records.map((r) => ({
      id: r._id,
      index: r._index,
      archiveName: r.archive_name,
      s3_key: r.s3_key,
      download_url: r.download_url,
    })),
  };
  zip.file('export_manifest.json', JSON.stringify(meta, null, 2));
  zip.file('all_records.csv', convertToCSV(records));
  zip.file('all_records.json', convertToJSON(records));

  const docsFolder = zip.folder('documents');
  if (docsFolder) {
    for (const record of records) {
      docsFolder.file(`${record._id}.json`, JSON.stringify(record, null, 2));
    }
  }

  try {
    const content = await zip.generateAsync({ type: 'blob' });
    downloadBlob(content, zipFilename, 'application/zip');
    return true;
  } catch (err) {
    console.error('Failed to generate ES export ZIP:', err);
    return false;
  }
}

/** @deprecated Use exportElasticsearchDocumentsZip — kept for compatibility */
export const downloadBulkAsZip = exportElasticsearchDocumentsZip;
