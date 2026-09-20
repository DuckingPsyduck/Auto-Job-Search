/**
 * Text extraction from a posting body: clearance language, pay range, repost signals.
 *
 * All patterns come from config (`extraction.*`) so a user in a different market can change
 * what is detected without touching code. Every extractor returns the evidence it matched, so
 * a workbook can show *why* a posting was labelled, not just the label.
 */

/** Strip HTML to readable text. Good enough for keyword extraction, not for display. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Classify clearance language.
 *
 * The distinction that matters to a candidate: a role requiring an ACTIVE clearance on day one
 * is closed to them, while "ability to obtain" or sponsorship is open. A structured field, when
 * the ATS provides one, always wins over prose.
 *
 * @returns {{status: string, evidence: string}}
 *   status: 'none' | 'public trust' | 'active required' | 'obtainable' | 'mentioned' | 'not stated'
 */
export function clearance(text, cfg) {
  const rules = cfg.extraction?.clearance || {};
  const body = String(text || '');
  if (!body) return { status: 'not stated', evidence: '' };

  const poly = rules.polygraph && new RegExp(rules.polygraph, 'i').test(body);
  const withPoly = s => (poly && !/^none|^public|^not stated/.test(s) ? `${s} + polygraph` : s);

  if (rules.structured_field) {
    const m = new RegExp(rules.structured_field, 'i').exec(body);
    if (m) {
      const value = (m[2] || '').trim();
      const status = /none|not required/i.test(value) ? 'none'
        : /public trust/i.test(value) ? 'public trust'
        : `active required: ${value}`;
      return { status: withPoly(status), evidence: m[0].slice(0, 200) };
    }
  }

  const active = rules.active && new RegExp(rules.active, 'i').exec(body);
  const obtainable = rules.obtainable && new RegExp(rules.obtainable, 'i').exec(body);
  const status = active ? (obtainable ? 'active required (obtain also mentioned)' : 'active required')
    : obtainable ? 'obtainable'
    : /clearance/i.test(body) ? 'mentioned — read the posting'
    : 'not stated';

  const hit = active || obtainable || /clearance/i.exec(body);
  return {
    status: withPoly(status),
    evidence: hit ? context(body, hit.index, hit[0].length) : '',
  };
}

/**
 * First posted pay range, as text plus parsed bounds.
 * @returns {{text: string, min: number|null, max: number|null}}
 */
export function pay(text, cfg) {
  const rx = cfg.extraction?.pay;
  if (!rx) return { text: '', min: null, max: null };
  const m = new RegExp(rx).exec(String(text || ''));
  if (!m) return { text: '', min: null, max: null };
  const raw = m[0].replace(/\s+/g, ' ').trim();
  const nums = raw.match(/\d[\d,]*(\.\d+)?\s?[kK]?/g) || [];
  const toNumber = s => {
    const n = Number(String(s).replace(/[,\s]/g, '').replace(/[kK]$/, '')) || null;
    return n && /[kK]$/.test(String(s).trim()) ? n * 1000 : n;
  };
  const [min, max] = [toNumber(nums[0]), toNumber(nums[1])];
  // An hourly range ($40.57 - $67.61) is not a salary; leave the bounds out rather than
  // comparing hourly numbers against an annual floor.
  const hourly = min !== null && min < 500;
  return { text: raw, min: hourly ? null : min, max: hourly ? null : max };
}

/**
 * Repost signal: a posting whose body references a date noticeably older than its listing.
 * Reposts look brand new on the board, so this is the only way to spot them from one scan.
 * @returns {string} evidence, or '' when nothing suggests a repost
 */
export function repostSignal(text, listedDate) {
  if (!listedDate) return '';
  const body = String(text || '');
  const listed = new Date(`${listedDate}T00:00:00Z`);
  const patterns = [
    /\b(?:posting|posted|published)\s*(?:date)?\s*[:\-]?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i,
    /\b(?:originally posted|first posted)\s*[:\-]?\s*([A-Z][a-z]+ \d{1,2},? \d{4})/i,
  ];
  for (const rx of patterns) {
    const m = rx.exec(body);
    if (!m) continue;
    const found = new Date(m[1].replace(/\./g, '/'));
    if (!Number.isNaN(found.valueOf())) {
      const daysOlder = Math.round((listed - found) / 86400000);
      if (daysOlder > 21) return `body says ${m[1]} (${daysOlder} days before the listing)`;
    }
  }
  return '';
}

/** A window of text around a match, for evidence columns. */
function context(body, index, length, pad = 60) {
  return body.slice(Math.max(0, index - pad), index + length + pad).replace(/\s+/g, ' ').trim();
}
