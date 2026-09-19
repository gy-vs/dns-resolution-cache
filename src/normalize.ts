import { InvalidHostnameError } from './errors.js';

/**
 * Canonical form used for cache keys and for the hostname handed to the
 * resolver: trimmed, lowercased, with trailing root dot(s) removed, so
 * "Example.COM.", "example.com" and "EXAMPLE.COM" share one cache entry.
 *
 * @throws {InvalidHostnameError} when nothing usable remains (e.g. "", ".").
 */
export function normalizeHostname(hostname: string): string {
  if (typeof hostname !== 'string') {
    throw new InvalidHostnameError(String(hostname));
  }
  let normalized = hostname.trim().toLowerCase();
  while (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.length === 0) {
    throw new InvalidHostnameError(hostname);
  }
  return normalized;
}

/** Canonical record type: trimmed, uppercased ("a" -> "A"). */
export function normalizeRecordType(type: string): string {
  const normalized = String(type).trim().toUpperCase();
  if (normalized.length === 0) {
    throw new TypeError('record type must be a non-empty string');
  }
  return normalized;
}
