/**
 * What the keywords did not catch.
 *
 * The sweep drops every posting whose title matched no target keyword — the overwhelming
 * majority, and not worth a line on disk each. But they are the only evidence a user has that
 * their keyword list is too narrow, and "my keywords are wrong" is invisible from the results
 * they do get: a search for "data engineer" that never heard of "analytics engineer" just looks
 * like a quiet day.
 *
 * So the titles are tallied in memory and the most common ones are written out, for
 * `ajs keywords` to turn into suggestions.
 */
import { writeFileSync } from 'node:fs';
import { workPath } from './config.mjs';

/** Distinct titles held at once. A day's index has hundreds of thousands; this bounds memory. */
const MAX_DISTINCT = 200_000;

export class UnmatchedTitles {
  constructor(limit = MAX_DISTINCT) {
    this.counts = new Map();
    this.limit = limit;
    this.seen = 0;
    this.overflowed = false;
  }

  add(title) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 120) return;
    this.seen++;
    const key = clean.toLowerCase();
    const current = this.counts.get(key);
    if (current !== undefined) {
      this.counts.set(key, current + 1);
      return;
    }
    // Once full, keep counting what we already track rather than growing without bound.
    if (this.counts.size >= this.limit) {
      this.overflowed = true;
      return;
    }
    this.counts.set(key, 1);
  }

  /** The most common titles, biggest first. */
  top(n = 500) {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([title, count]) => ({ title, count }));
  }

  /**
   * Write the tally for the day. Returns the path, or null when there was nothing to write.
   */
  write(cfg, date) {
    if (!this.seen) return null;
    const path = workPath(cfg, `unmatched-titles-${date}.json`);
    writeFileSync(path, `${JSON.stringify({
      date,
      titles_seen: this.seen,
      distinct_kept: this.counts.size,
      truncated: this.overflowed,
      top: this.top(),
    }, null, 1)}\n`, 'utf8');
    return path;
  }
}
