/**
 * csvpreview.js
 *
 * Reads just the first rows of a CSV as it downloads, so previewing a table
 * with a hundred thousand answers doesn't fetch all of them. Handles quoted
 * fields with commas, doubled quotes and line breaks, the way the connector
 * writes them.
 */

/**
 * @param {number} maxRows data rows to keep, after the header
 * @returns {{ push(text: string): boolean, finish(): {columns, rows, truncated} }}
 *          push returns true once enough rows have been read.
 */
function createPreviewReader(maxRows) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let quotePending = false; // saw a quote inside quotes; next char decides
  let started = false;
  let skipLf = false;
  let full = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    if (records.length > maxRows + 1) full = true; // header + maxRows + one more proves truncation
  };

  function push(text) {
    if (full) return true;
    for (let i = 0; i < text.length; i += 1) {
      let ch = text[i];
      if (!started) {
        started = true;
        if (ch === '﻿') continue;
      }
      if (skipLf) {
        skipLf = false;
        if (ch === '\n') continue;
      }

      if (quotePending) {
        quotePending = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        inQuotes = false; // that quote closed the field; handle ch normally
      }

      if (inQuotes) {
        if (ch === '"') quotePending = true;
        else field += ch;
        continue;
      }

      if (ch === '"' && field === '') {
        inQuotes = true;
      } else if (ch === ',') {
        endField();
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r') skipLf = true;
        endRecord();
        if (full) return true;
      } else {
        field += ch;
      }
    }
    return full;
  }

  function finish() {
    if (!full && (field !== '' || record.length > 0)) endRecord();
    const [columns = [], ...rest] = records;
    return {
      columns,
      rows: rest.slice(0, maxRows),
      truncated: rest.length > maxRows,
    };
  }

  return { push, finish };
}

module.exports = { createPreviewReader };
