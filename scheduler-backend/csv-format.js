/**
 * csv-format.js — Convert rows of objects to a CSV string.
 *
 * CRLF line endings for Excel friendliness. Cells containing comma, double
 * quote, CR, or LF get quoted; embedded quotes are doubled. null/undefined
 * render as empty cells. Column order follows the `columns` argument — row
 * key order is ignored.
 *
 * Always emits a header row followed by a trailing CRLF (even with zero
 * data rows) so that downstream tooling can rely on `\r\n` terminators.
 */

function escapeCell(value) {
    if (value == null) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * @param {Array<Object>} rows
 * @param {Array<string>} columns - column names in the order they should appear
 * @returns {string} CSV text with CRLF line endings
 */
function toCsv(rows, columns) {
    const lines = [columns.map(escapeCell).join(',')];
    for (const row of rows) {
        lines.push(columns.map(col => escapeCell(row[col])).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, escapeCell };
