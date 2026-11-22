// A faster drop-in for make.fun's own csv-reader 1.0.0: run(input) returns, for every case's
// input {text, header}, exactly the answer csv-reader 1.0.0 returns: {columns, rows, errors}.
//
// The reference reads one character at a time and builds every field up a character at a time.
// This module reads the same way, field for field and record for record, but jumps from one
// delimiter to the next and takes each field as a slice of the text instead of building it up.
// Most records live on one physical line with no CR inside them; those are read by a fast
// line parser that needs only one delimiter search per field. Anything the fast parser cannot
// prove identical — a quoted field that runs past the line's end, or a CR inside a field — is
// handed to the general record loop below, which is also the only place that goes character by
// character: a quoted field that holds a doubled quote or a line break, and the junk after a
// closing quote. Every error, every line number and every padding/cut of a ragged row follows
// csv-reader 1.0.0's written policy exactly:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote, and each CRLF or lone CR inside it is read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after
//     it (every record when header is false), each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF,
//     CRLF and lone CR inside a quoted field counted), row its record's index in rows (null
//     for the header), in the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** The next comma, LF or CR at or after the regex's lastIndex (slow paths only). */
const DELIM = /[,\n\r]/g;

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read (helpers and the inlined unquoted scan write here, so no object is
  // built per field): its value, how it ended, and — for the junk scan — how many characters
  // the scan itself kept.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;
  // Whether the last field the line parser read was quoted (for the no-record rule).
  let fLastQuoted = false;
  // The first CR at or after the last position it was computed for (-2: not yet computed,
  // -1: none). pos never moves backwards, so this stays valid as pos advances.
  let nextCr = -2;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed
  // by LF is dropped (stray_cr). Sets fValue/fEnded/fAdded; `added` counts the characters kept.
  // Used for the rare paths — the junk after a closing quote, and the re-read after a quote
  // that never closes — while the common unquoted field is scanned inline in the record loop.
  // Jumps from one delimiter to the next instead of reading a character at a time; a stretch
  // with no delimiter at all is taken as one slice.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        value += text.slice(start);
        added += n - start;
        pos = n;
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      const d = m.index;
      const c = text.charCodeAt(d);
      if (c === 44) {
        // ','
        value += text.slice(start, d);
        added += d - start;
        pos = d + 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      if (c === 10) {
        // '\n'
        value += text.slice(start, d);
        added += d - start;
        pos = d + 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      // '\r'
      if (text.charCodeAt(d + 1) === 10) {
        value += text.slice(start, d);
        added += d - start;
        pos = d + 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(start, d);
      added += d - start;
      pos = d + 1;
      start = d + 1;
    }
    fValue = value;
    fEnded = END;
    fAdded = added;
  }

  // Builds a quoted field's value out of the raw slice between its quotes: "" collapses to one
  // quote, and each CRLF or lone CR inside it is read as one LF (and counts one line).
  function buildQuotedValue(s) {
    let v = '';
    let i = 0;
    const m = s.length;
    while (i < m) {
      let j = m;
      const dq = s.indexOf('"', i);
      if (dq !== -1 && dq < j) j = dq;
      const cr = s.indexOf('\r', i);
      if (cr !== -1 && cr < j) j = cr;
      const lf = s.indexOf('\n', i);
      if (lf !== -1 && lf < j) j = lf;
      if (j === m) {
        v += s.slice(i);
        break;
      }
      v += s.slice(i, j);
      const c = s.charCodeAt(j);
      if (c === 34) {
        // '"' here is always one of a doubled pair: the closing quote is the first one not
        // followed by another quote, so every quote inside the slice is doubled.
        v += '"';
        i = j + 2;
      } else if (c === 13) {
        v += '\n';
        line += 1;
        i = s.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
      } else {
        v += '\n';
        line += 1;
        i = j + 1;
      }
    }
    return v;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue/fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // The closing quote is the first '"' not followed by another '"'.
    let q = text.indexOf('"', pos);
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again
      // as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    const raw = text.slice(pos, q);
    const value =
      raw.indexOf('"') === -1 && raw.indexOf('\r') === -1 && raw.indexOf('\n') === -1
        ? raw
        : buildQuotedValue(raw);
    const after = q + 1;
    if (after >= n) {
      pos = n;
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(after);
    if (c === 44) {
      pos = after + 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos = after + 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(after + 1) === 10) {
      pos = after + 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line
    // break.
    pos = after;
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Tries to read the record at pos as one physical line: the text up to the next LF (or the
  // end of the text), minus the CR of a CRLF. The caller has already established that the line
  // holds no CR (nextCr), so no field of it can hold one either. Returns the record's fields
  // when the line holds the whole record; returns null when it cannot prove that — a quoted
  // field whose closing quote lies past the line's end — and the general loop then reads the
  // record instead. On success pos and line are moved past the line and its errors are
  // already in `errors`.
  function tryLineRecord() {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    let contentEnd = lineEnd;
    if (nl !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) contentEnd--;
    if (contentEnd <= pos) return null;
    // A CR anywhere in the content is the general loop's business (a stray_cr in an
    // unquoted field, a line break in a quoted one, junk rules after a closing quote):
    // the first CR at or after pos decides, and the CR of a CRLF sits at contentEnd.
    if (nextCr !== -1 && nextCr < contentEnd) return null;
    const fields = [];
    let pending = null;
    let p = pos;
    let lastQuoted = false;
    let more = true;
    while (more) {
      more = false;
      if (p < contentEnd && text.charCodeAt(p) === 34) {
        // A quoted field that closes on this same line.
        lastQuoted = true;
        let q = text.indexOf('"', p + 1);
        let doubled = false;
        while (q !== -1 && q < contentEnd && text.charCodeAt(q + 1) === 34) {
          doubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1 || q >= contentEnd) return null; // closes on a later line, or never
        let value;
        if (!doubled) {
          value = text.slice(p + 1, q);
        } else {
          // Every quote between the pair is one of a doubled pair; collapse each to one.
          value = '';
          let i = p + 1;
          while (i < q) {
            const dq = text.indexOf('"', i);
            if (dq === -1 || dq >= q) {
              value += text.slice(i, q);
              break;
            }
            value += text.slice(i, dq) + '"';
            i = dq + 2;
          }
        }
        const after = q + 1;
        if (after >= contentEnd) {
          fields.push(value);
        } else if (text.charCodeAt(after) === 44) {
          fields.push(value);
          p = after + 1;
          more = true;
        } else {
          // Junk after the closing quote, up to the next comma or the line's end.
          let junkEnd = text.indexOf(',', after);
          if (junkEnd === -1 || junkEnd > contentEnd) junkEnd = contentEnd;
          const junk = text.slice(after, junkEnd);
          if (junk.length > 0) {
            if (pending === null) pending = [];
            pending.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
          fields.push(value + junk);
          if (junkEnd < contentEnd) {
            p = junkEnd + 1;
            more = true;
          }
        }
      } else {
        // An unquoted field: up to the next comma or the line's end. A quote inside it is a
        // literal character, so only the comma is searched for.
        lastQuoted = false;
        let d = text.indexOf(',', p);
        if (d === -1 || d > contentEnd) d = contentEnd;
        fields.push(text.slice(p, d));
        if (d < contentEnd) {
          p = d + 1;
          more = true;
        }
      }
    }
    if (pending !== null) for (const e of pending) errors.push(e);
    pos = nl === -1 ? n : nl + 1;
    if (nl !== -1) line += 1;
    fLastQuoted = lastQuoted;
    return fields;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    if (nextCr !== -1 && nextCr < pos) nextCr = text.indexOf('\r', pos);
    const fast = tryLineRecord();
    if (fast !== null) {
      // The record tail, the same steps as at the end of the general loop below. It is kept
      // inline in both places on purpose: passing the fields array to a shared helper makes
      // V8's garbage collector work far harder on this allocation-heavy loop (measured:
      // ~15x the GC pause over the practice set), for no change in output.
      if (!(fast.length === 1 && fast[0] === '' && !fLastQuoted)) {
        if (width < 0) width = fast.length;
        if (header && columns === null) {
          columns = fast;
        } else {
          if (fast.length < width) {
            errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fast.length });
            while (fast.length < width) fast.push('');
          } else if (fast.length > width) {
            errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fast.splice(width) });
          }
          rows.push(fast);
        }
      }
      continue;
    }

    const fields = [];
    let quoted;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        // Inline unquoted scan: the next ',' or LF bounds the field, and the slice between
        // here and there is the field — unless a CR sits inside it (a stray CR, or the CR of
        // a CRLF line break), in which case the slow scan takes over from here.
        const dc = text.indexOf(',', pos);
        const dn = text.indexOf('\n', pos);
        let d;
        let isComma;
        if (dc === -1) {
          d = dn;
          isComma = false;
        } else if (dn === -1) {
          d = dc;
          isComma = true;
        } else if (dc < dn) {
          d = dc;
          isComma = true;
        } else {
          d = dn;
          isComma = false;
        }
        if (d === -1) {
          const seg = text.slice(pos);
          if (seg.indexOf('\r') === -1) {
            fValue = seg;
            pos = n;
            fEnded = END;
          } else {
            readUnquoted('');
          }
        } else if (isComma) {
          const seg = text.slice(pos, d);
          if (seg.indexOf('\r') === -1) {
            fValue = seg;
            pos = d + 1;
            fEnded = COMMA;
          } else {
            readUnquoted('');
          }
        } else {
          // LF at d; a CR just before it is the CR of a CRLF line break.
          const end = d > pos && text.charCodeAt(d - 1) === 13 ? d - 1 : d;
          const seg = text.slice(pos, end);
          if (seg.indexOf('\r') === -1) {
            fValue = seg;
            pos = d + 1;
            line += 1;
            fEnded = LINE_BREAK;
          } else {
            readUnquoted('');
          }
        }
      }
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
