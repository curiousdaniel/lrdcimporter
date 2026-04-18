/* global XLSX */
(function () {
  'use strict';

  var MAX_HASH_PAYLOAD_CHARS = 14000;
  var RECORDED_LS_KEY = 'dbOfflineRecordedKeys';

  var state = {
    donorRows: [],
    donorByEmail: new Map(),
    donorDuplicateEmails: new Set(),
    offlineHeaders: [],
    offlineRows: [],
    formId: '277791',
    nextRowIndex: 0,
    rowUrls: [],
    dbConfigured: false,
    /** row_key -> { recorded: boolean, recordedAt: string|null } from Neon lookup */
    recordedFromDb: {},
    dbLookupTimer: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function parseCSV(text) {
    var rows = [];
    var i = 0;
    var field = '';
    var row = [];
    var inQ = false;
    while (i < text.length) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (c === ',') {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      if (c === '\r') {
        i++;
        continue;
      }
      if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        continue;
      }
      field += c;
      i++;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    if (!rows.length) return { headers: [], records: [] };
    return rowsToHeaderRecords(rows);
  }

  function normHeader(h) {
    return String(h || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function findCol(headers, candidates) {
    var map = {};
    for (var i = 0; i < headers.length; i++) {
      map[normHeader(headers[i])] = headers[i];
    }
    for (var j = 0; j < candidates.length; j++) {
      var key = normHeader(candidates[j]);
      if (map[key]) return map[key];
    }
    return '';
  }

  function dedupeHeaders(raw) {
    var counts = {};
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var base = String(raw[i] || '').trim() || 'Column ' + (i + 1);
      counts[base] = (counts[base] || 0) + 1;
      out.push(counts[base] === 1 ? base : base + ' (' + counts[base] + ')');
    }
    return out;
  }

  function rowMaxCellLen(row) {
    var m = 0;
    for (var ri = 0; ri < (row || []).length; ri++) {
      var L = String(row[ri] || '').trim().length;
      if (L > m) m = L;
    }
    return m;
  }

  /** Keyword header row — ignore narrative rows (any cell very long). */
  function headerKeywordScore(row) {
    if (!row || !row.length) return 0;
    if (rowMaxCellLen(row) > 48) return 0;
    var keys = [
      'email',
      'gross',
      'net',
      'fee',
      'date',
      'time zone',
      'timezone',
      'currency',
      'transaction',
      'balance',
      'status',
      'type',
      'name',
      'item',
      'quantity',
      'address',
      'payment',
      'amount',
    ];
    var score = 0;
    for (var c = 0; c < row.length; c++) {
      var t = normHeader(String(row[c] || ''));
      if (!t || t.length > 36) continue;
      for (var k = 0; k < keys.length; k++) {
        if (t.indexOf(keys[k]) !== -1) {
          score++;
          break;
        }
      }
    }
    return score;
  }

  function sliceRowsToRecords(rows, hi, maxRecords) {
    maxRecords = maxRecords || 999999;
    var rawHeaders = (rows[hi] || []).map(function (h) {
      return String(h || '').trim();
    });
    var headers = dedupeHeaders(rawHeaders);
    if (!headers.length) return { headers: [], records: [] };
    var records = [];
    for (var r = hi + 1; r < rows.length && records.length < maxRecords; r++) {
      var cells = rows[r] || [];
      var empty = true;
      for (var c = 0; c < cells.length; c++) {
        if (String(cells[c]).trim() !== '') {
          empty = false;
          break;
        }
      }
      if (empty) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        var key = headers[j];
        var cell = cells[j];
        if (cell instanceof Date) obj[key] = cell;
        else obj[key] = cell != null ? String(cell) : '';
      }
      records.push(obj);
    }
    return { headers: headers, records: records };
  }

  function pickHeaderRowIndexKeywordFallback(rows) {
    var maxScan = Math.min(15, rows.length);
    var best = 0;
    var bestScore = -1;
    for (var i = 0; i < maxScan; i++) {
      if (rowMaxCellLen(rows[i]) > 48) continue;
      var sc = headerKeywordScore(rows[i]);
      if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    }
    if (bestScore < 2) return 0;
    return best;
  }

  /** Prefer the row below which the most cells look like donor emails (beats instruction banners). */
  function pickHeaderRowIndex(rows) {
    if (!rows || rows.length < 2) return 0;
    var maxTry = Math.min(15, rows.length - 1);
    var bestHi = 0;
    var bestHits = -1;
    var bestDensity = -1;
    for (var hi = 0; hi < maxTry; hi++) {
      var sr = sliceRowsToRecords(rows, hi, 400);
      if (sr.records.length < 2) continue;
      var inf = inferEmailColumnScore(sr.headers, sr.records);
      var sample = Math.min(sr.records.length, 250);
      var density = inf.hits / Math.max(1, sample);
      if (inf.hits > bestHits || (inf.hits === bestHits && inf.hits > 0 && density > bestDensity)) {
        bestHits = inf.hits;
        bestHi = hi;
        bestDensity = density;
      }
    }
    if (bestHits >= 1) return bestHi;
    return pickHeaderRowIndexKeywordFallback(rows);
  }

  function rowsToHeaderRecords(rows) {
    if (!rows || !rows.length) return { headers: [], records: [] };
    var hi = pickHeaderRowIndex(rows);
    return sliceRowsToRecords(rows, hi, 999999);
  }

  function looksLikeEmail(s) {
    var t = String(s == null ? '' : s)
      .trim()
      .toLowerCase();
    if (t.indexOf('@') < 1) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
  }

  function inferEmailColumnScore(headers, records) {
    var bestH = '';
    var bestHits = -1;
    var sampledBest = 0;
    var limit = Math.min(250, records.length);
    for (var c = 0; c < headers.length; c++) {
      var h = headers[c];
      var hits = 0;
      var nonEmpty = 0;
      for (var r = 0; r < limit; r++) {
        var v = records[r][h];
        if (v == null || String(v).trim() === '') continue;
        nonEmpty++;
        if (looksLikeEmail(v)) hits++;
      }
      if (
        hits > bestHits ||
        (hits === bestHits && hits > 0 && nonEmpty > sampledBest)
      ) {
        bestHits = hits;
        bestH = h;
        sampledBest = nonEmpty;
      }
    }
    if (bestHits < 1) return { header: '', hits: 0, sampled: 0 };
    return { header: bestH, hits: bestHits, sampled: sampledBest };
  }

  function findColSubstring(headers, patterns) {
    for (var p = 0; p < patterns.length; p++) {
      var needle = normHeader(patterns[p]);
      if (needle.length < 3) continue;
      for (var i = 0; i < headers.length; i++) {
        var nh = normHeader(headers[i]);
        if (nh.indexOf(needle) !== -1) return headers[i];
      }
    }
    return '';
  }

  function countEmailHitsInColumn(headers, records, colName) {
    if (!colName) return 0;
    var hits = 0;
    var limit = Math.min(250, records.length);
    for (var r = 0; r < limit; r++) {
      if (looksLikeEmail(records[r][colName])) hits++;
    }
    return hits;
  }

  function chooseEmailColumn(headers, records) {
    var exact = findCol(headers, ['email', 'e-mail', 'donor email']);
    var sub = findColSubstring(headers, [
      'from email address',
      'from email',
      'payer email',
      'buyer email',
      'paypal email',
      'customer email',
      'to email address',
      'counterparty email',
    ]);
    var inf = inferEmailColumnScore(headers, records);
    var exactHits = exact ? countEmailHitsInColumn(headers, records, exact) : 0;
    var subHits = sub ? countEmailHitsInColumn(headers, records, sub) : 0;

    if (inf.hits >= 3 && inf.hits >= exactHits && inf.hits >= subHits) return inf.header;
    if (exact && exactHits >= 3) return exact;
    if (sub && subHits >= 3) return sub;
    if (exact) return exact;
    if (sub) return sub;
    if (inf.header && inf.hits >= 1) return inf.header;
    return '';
  }

  /** Exact strings shown in Donorbox “The Purpose of Your Donation:” dropdown (for pass-through match). */
  var DONORBOX_PURPOSE_OPTION_LABELS = [
    'General Donation to Lion\'s Roar Dharma Center',
    'Membership (minimum $50/mo)',
    'Donate to Lama Jinpa\'s Care Fund',
    'April Retreat 2026',
    'Darshan',
    'Donate to support Lion\'s Roar Building',
    'Donate to Sera Jey Monastery',
    'Book Donation',
    'Retreat Studio',
  ];

  /** Spreadsheet “Product/Service full name” → exact Donorbox dropdown label. */
  var PRODUCT_SERVICE_TO_PURPOSE = {
    '4010 Membership Pledge': 'Membership (minimum $50/mo)',
    '4002 General Donations': "General Donation to Lion's Roar Dharma Center",
    '4253 Workshops': "General Donation to Lion's Roar Dharma Center",
    'Monastic Support (category):7050 Lama Jinpa Donations': "Donate to Lama Jinpa's Care Fund",
    '4252 Retreat': 'April Retreat 2026',
    '4004 Credit Card Donations': "General Donation to Lion's Roar Dharma Center",
  };

  function normalizeProductServiceKey(s) {
    return String(s == null ? '' : s)
      .trim()
      .replace(/\s+/g, ' ');
  }

  function mapProductServiceToPurpose(raw) {
    var key = normalizeProductServiceKey(raw);
    if (!key) return '';
    if (Object.prototype.hasOwnProperty.call(PRODUCT_SERVICE_TO_PURPOSE, key)) {
      return PRODUCT_SERVICE_TO_PURPOSE[key];
    }
    var lower = key.toLowerCase();
    for (var i = 0; i < DONORBOX_PURPOSE_OPTION_LABELS.length; i++) {
      if (DONORBOX_PURPOSE_OPTION_LABELS[i].toLowerCase() === lower) {
        return DONORBOX_PURPOSE_OPTION_LABELS[i];
      }
    }
    return '';
  }

  function applySmartColumnDefaults(hdrs, records) {
    fillSelect($('colEmail'), hdrs, []);
    fillSelect($('colAmount'), hdrs, []);
    fillSelect($('colDonationDate'), hdrs, []);
    fillSelect($('colDepositDate'), hdrs, []);
    fillSelect($('colPayment'), hdrs, []);
    fillSelect($('colCheck'), hdrs, []);
    fillSelect($('colProduct'), hdrs, []);
    if ($('colDonorName')) fillSelect($('colDonorName'), hdrs, []);
    if ($('colMemo')) fillSelect($('colMemo'), hdrs, []);

    var emailCol = chooseEmailColumn(hdrs, records);
    if (emailCol) $('colEmail').value = emailCol;

    var amountCol =
      findCol(hdrs, ['amount', 'donation amount', 'gift amount', 'payment amount', 'gross', 'net']) ||
      findColSubstring(hdrs, ['payment gross', 'total paid', 'gross amount']);
    if (amountCol) $('colAmount').value = amountCol;

    var donationDateCol =
      findCol(hdrs, [
        'donation date',
        'donation_date',
        'date donated',
        'gift date',
        'transaction date',
        'payment date',
        'completed date',
      ]) || findColSubstring(hdrs, ['transaction date', 'payment date', 'donation date']);
    if (donationDateCol) $('colDonationDate').value = donationDateCol;

    var depositCol =
      findCol(hdrs, [
        'deposit date',
        'deposit_date',
        'bank date',
        'date deposited',
      ]) || findColSubstring(hdrs, ['deposit date', 'bank date']);
    if (depositCol) $('colDepositDate').value = depositCol;

    var payCol =
      findCol(hdrs, [
        'payment',
        'payment type',
        'method',
        'donation_type',
        'type',
        'txn type',
        'transaction type',
      ]) || findColSubstring(hdrs, ['payment type', 'transaction type', 'txn type']);
    if (payCol) $('colPayment').value = payCol;

    var checkCol =
      findCol(hdrs, ['check', 'check number', 'check #', 'check_no', 'check no']) ||
      findColSubstring(hdrs, ['check number', 'check #']);
    if (checkCol) $('colCheck').value = checkCol;

    var productCol =
      findCol(hdrs, ['product/service full name', 'product service full name']) ||
      findColSubstring(hdrs, ['product/service', 'product service full']);
    if (productCol) $('colProduct').value = productCol;

    var nameCol =
      findCol(hdrs, [
        'name',
        'donor name',
        'full name',
        'customer name',
        'from name',
        'payer name',
        'buyer name',
        'contact name',
      ]) || findColSubstring(hdrs, ['from name', 'donor name', 'customer name']);
    if (nameCol && $('colDonorName')) $('colDonorName').value = nameCol;

    var memoCol =
      findCol(hdrs, ['memo', 'description', 'notes', 'note', 'subject', 'message', 'detail']) ||
      findColSubstring(hdrs, ['item title', 'transaction note', 'memo', 'description']);
    if (memoCol && $('colMemo')) $('colMemo').value = memoCol;
  }

  function updateMappingHints() {
    var el = $('mappingHints');
    if (!el) return;
    var map = getMapping();
    var rows = state.offlineRows;
    if (!rows.length) {
      el.hidden = true;
      return;
    }
    var lines = [];
    var warn = false;
    if (map.email) {
      var sample = rows[0] ? rows[0][map.email] : '';
      var preview = String(sample == null ? '' : sample).trim();
      if (preview.length > 80) preview = preview.slice(0, 80) + '…';
      lines.push('Email column “' + map.email + '” — first row value: ' + (preview || '(empty)'));
      if (preview && !looksLikeEmail(preview)) {
        lines.push('That does not look like an email address. Choose the column that contains donor emails (e.g. From Email Address).');
        warn = true;
      }
    } else {
      lines.push('No donor email column selected.');
      warn = true;
    }
    var matched = 0;
    var checked = Math.min(80, rows.length);
    for (var i = 0; i < checked; i++) {
      var em = map.email ? rows[i][map.email] : '';
      var res = resolveSupporterId(em);
      if (res.id != null) matched++;
    }
    lines.push(
      'Donor match in first ' +
        checked +
        ' rows: ' +
        matched +
        ' of ' +
        checked +
        ' (needs Donorbox export loaded with matching emails).'
    );
    if (matched === 0 && state.donorByEmail && state.donorByEmail.size) {
      warn = true;
    }
    el.textContent = lines.join('\n');
    el.hidden = false;
    el.className = 'meta' + (warn ? ' warn' : '');
  }

  function buildDonorIndex(headers, records) {
    var emailKey = findCol(headers, ['email', 'e-mail']);
    var idKey = findCol(headers, ['id', 'donor id', 'supporter id']);
    var byEmail = new Map();
    var all = [];
    var dup = new Set();
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var email = emailKey ? String(rec[emailKey] || '').trim().toLowerCase() : '';
      var idStr = idKey ? String(rec[idKey] || '').trim() : '';
      var idNum = parseInt(idStr, 10);
      if (!email || !idNum) continue;
      all.push({ email: email, id: idNum, raw: rec });
      if (byEmail.has(email)) {
        dup.add(email);
        var prev = byEmail.get(email);
        if (idNum > prev) byEmail.set(email, idNum);
      } else {
        byEmail.set(email, idNum);
      }
    }
    return { list: all, byEmail: byEmail, duplicates: dup, emailKey: emailKey, idKey: idKey };
  }

  function excelSerialToYMD(serial) {
    var n = Number(serial);
    if (!isFinite(n) || n < 1) return '';
    var utc = Math.round((n - 25569) * 86400 * 1000);
    var d = new Date(utc);
    if (isNaN(d.getTime())) return '';
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var day = String(d.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function toISODate(val) {
    if (val == null || val === '') return '';
    if (val instanceof Date && !isNaN(val.getTime())) {
      var y = val.getFullYear();
      var m = String(val.getMonth() + 1).padStart(2, '0');
      var d = String(val.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
    if (typeof val === 'number' && val > 20000 && val < 60000) {
      return excelSerialToYMD(val);
    }
    var s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) {
      var mm = mdy[1].padStart(2, '0');
      var dd = mdy[2].padStart(2, '0');
      return mdy[3] + '-' + mm + '-' + dd;
    }
    var t = Date.parse(s);
    if (!isNaN(t)) {
      var d2 = new Date(t);
      var y2 = d2.getFullYear();
      var m2 = String(d2.getMonth() + 1).padStart(2, '0');
      var day2 = String(d2.getDate()).padStart(2, '0');
      return y2 + '-' + m2 + '-' + day2;
    }
    return '';
  }

  function encodePayload(obj) {
    var json = JSON.stringify(obj);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function payloadHash(data) {
    var full = data.orgComments || '';
    var MARK = '\n\nRaw Data: ';
    var splitIdx = full.indexOf(MARK);
    var base = Object.assign({}, data);
    var safety = 0;
    var truncated = false;
    var ip = full;
    var rawSuffix = '';
    if (splitIdx >= 0) {
      ip = full.slice(0, splitIdx);
      rawSuffix = full.slice(splitIdx);
    }
    var note = full;
    while (safety++ < 70) {
      base.orgComments = note;
      var enc = encodePayload(base);
      if (enc.length <= MAX_HASH_PAYLOAD_CHARS) {
        return { enc: enc, truncated: truncated || note !== full };
      }
      if (splitIdx >= 0 && rawSuffix.length > MARK.length + 40) {
        var tsv = rawSuffix.slice(MARK.length);
        tsv = tsv.slice(0, Math.max(20, Math.floor(tsv.length * 0.88)));
        rawSuffix = MARK + tsv;
        note = ip + rawSuffix;
        truncated = true;
        continue;
      }
      if (splitIdx >= 0 && ip.length > 60) {
        ip = ip.slice(0, Math.max(40, Math.floor(ip.length * 0.88)));
        note = ip + rawSuffix;
        truncated = true;
        continue;
      }
      note =
        note.slice(0, Math.max(80, Math.floor(note.length * 0.75))) +
        '\n[... truncated for browser URL length; full row is in your offline file ...]';
      truncated = true;
    }
    base.orgComments = '[payload too large]';
    return { enc: encodePayload(base), truncated: true };
  }

  function buildDonorUrl(supporterId, payloadEnc) {
    var fid = state.formId || '277791';
    return (
      'https://donorbox.org/org_admin/supporters/' +
      encodeURIComponent(String(supporterId)) +
      '/donor_donations/new?form_id=' +
      encodeURIComponent(String(fid)) +
      '#dbOffline=' +
      payloadEnc
    );
  }

  /** Map spreadsheet payment labels to Donorbox <select> values. */
  function normalizePaymentType(raw) {
    var s = String(raw == null ? '' : raw);
    var t = s.trim().toLowerCase();
    if (!t) return '';
    if (/paypal|pay\s*pal|^pp$|pp\s*checkout|pay\s*pal\s*checkout|express\s*checkout|website\s*payment|send\s*money/i.test(s)) {
      return 'paypal';
    }
    if (/venmo|cash\s*app|apple\s*pay|google\s*pay|credit|debit|visa|mastercard|amex|discover|card/i.test(s)) {
      return 'credit_card';
    }
    if (/ach|bank\s*transfer|wire|eft|echeck|e-check/i.test(s)) return 'external_bank_transfer';
    if (/check|cheque/i.test(s)) return 'check';
    if (t === 'cash') return 'cash';
    if (/crypto|bitcoin|btc/i.test(s)) return 'cryptocurrency';
    return t.replace(/\s+/g, '_').slice(0, 48);
  }

  /** If any cell mentions PayPal (e.g. Item title), treat as PayPal even when Type column only says "Payment". */
  function inferPaypalFromRowCells(row, headers) {
    var parts = [];
    for (var i = 0; i < headers.length; i++) {
      parts.push(String(row[headers[i]] == null ? '' : row[headers[i]]));
    }
    return /paypal/i.test(parts.join('\t'));
  }

  /** One spreadsheet row as tab-separated values (column order = file headers). */
  function rowAsRawTsv(headers, row) {
    return headers
      .map(function (h) {
        var v = row[h];
        if (v == null) return '';
        return String(v).replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
      })
      .join('\t');
  }

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  /** Stable id for “recorded” state: supporter id, key fields, and row content fingerprint. */
  function rowRecordKey(row, map, headers) {
    var email = map.email ? String(row[map.email] || '').trim().toLowerCase() : '';
    var amount = map.amount ? String(row[map.amount] || '').replace(/[$,]/g, '').trim() : '';
    var dd = map.donationDate ? toISODate(row[map.donationDate]) : '';
    var dep = map.depositDate ? toISODate(row[map.depositDate]) : '';
    var chk = map.check ? String(row[map.check] || '').trim() : '';
    var res = resolveSupporterId(map.email ? row[map.email] : '');
    var sid = res.id != null ? String(res.id) : '';
    var tsv = rowAsRawTsv(headers, row);
    var fp = hashStr(tsv.slice(0, 5000));
    return sid + '|' + email + '|' + dd + '|' + dep + '|' + amount + '|' + chk + '|' + fp;
  }

  function loadRecordedKeys() {
    try {
      var raw = localStorage.getItem(RECORDED_LS_KEY);
      if (!raw) return {};
      var data = JSON.parse(raw);
      if (data && typeof data === 'object' && data.keys && typeof data.keys === 'object') {
        return data.keys;
      }
    } catch (e) {
      /* ignore */
    }
    return {};
  }

  function saveRecordedKeys(keys) {
    try {
      localStorage.setItem(RECORDED_LS_KEY, JSON.stringify({ v: '1', keys: keys }));
    } catch (e) {
      /* ignore */
    }
  }

  function formatRecordedAt(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
      return '';
    }
  }

  function rowDisplayValues(row, map) {
    var dn = map.donorName ? String(row[map.donorName] == null ? '' : row[map.donorName]).trim() : '';
    var amt = map.amount ? String(row[map.amount] == null ? '' : row[map.amount]).trim() : '';
    var payRaw = map.payment ? row[map.payment] : '';
    var pay = String(payRaw == null ? '' : payRaw).trim();
    var memo = map.memo ? String(row[map.memo] == null ? '' : row[map.memo]).trim() : '';
    return { donorName: dn, amount: amt, payment: pay, memo: memo };
  }

  function clipCell(text, maxLen) {
    var s = String(text == null ? '' : text);
    if (s.length <= maxLen) return { text: s, title: '' };
    return { text: s.slice(0, Math.max(1, maxLen - 1)) + '…', title: s };
  }

  function getRecordedInfo(rowKey, localKeys) {
    if (Object.prototype.hasOwnProperty.call(state.recordedFromDb, rowKey)) {
      var d = state.recordedFromDb[rowKey];
      return { recorded: !!d.recorded, recordedAt: d.recordedAt || null };
    }
    return { recorded: !!localKeys[rowKey], recordedAt: null };
  }

  function updateDbHint() {
    var el = $('dbStatusHint');
    if (!el) return;
    var btn = $('btnSaveImportDb');
    if (btn) btn.disabled = !state.dbConfigured;
    if (!state.dbConfigured) {
      el.textContent =
        'Database: not configured (set DATABASE_URL on Vercel or in .env.local for local dev). Recorded state uses this browser only.';
      el.hidden = false;
      el.className = 'meta';
      return;
    }
    el.textContent =
      'Database: connected. Row metadata and recorded status sync to Neon when you use “Save import to database” and when you mark rows.';
    el.hidden = false;
    el.className = 'meta';
  }

  function scheduleDbLookup() {
    if (!state.dbConfigured) return;
    if (state.dbLookupTimer) clearTimeout(state.dbLookupTimer);
    state.dbLookupTimer = setTimeout(function () {
      state.dbLookupTimer = null;
      performDbLookup();
    }, 400);
  }

  function performDbLookup() {
    if (!state.dbConfigured || !state.offlineRows.length) return;
    var map = getMapping();
    var allKeys = [];
    for (var i = 0; i < state.offlineRows.length; i++) {
      allKeys.push(rowRecordKey(state.offlineRows[i], map, state.offlineHeaders));
    }
    var unique = [];
    var seen = {};
    for (var j = 0; j < allKeys.length; j++) {
      if (seen[allKeys[j]]) continue;
      seen[allKeys[j]] = 1;
      unique.push(allKeys[j]);
    }
    for (var k = 0; k < unique.length; k++) {
      delete state.recordedFromDb[unique[k]];
    }
    var pos = 0;
    var chunk = 400;
    function nextChunk() {
      var slice = unique.slice(pos, pos + chunk);
      pos += chunk;
      if (!slice.length) {
        refreshTable();
        return;
      }
      fetch('/api/donation-rows/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: slice }),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (data && Array.isArray(data.rows)) {
            for (var x = 0; x < data.rows.length; x++) {
              var row = data.rows[x];
              var rk = row.row_key;
              if (!rk) continue;
              var ra = row.recorded_at;
              state.recordedFromDb[rk] = {
                recorded: !!row.recorded,
                recordedAt: ra ? new Date(ra).toISOString() : null,
              };
            }
          }
        })
        .catch(function () {
          /* ignore */
        })
        .finally(function () {
          nextChunk();
        });
    }
    nextChunk();
  }

  function buildSyncRowsPayload() {
    var map = getMapping();
    var localKeys = loadRecordedKeys();
    var rows = [];
    for (var i = 0; i < state.offlineRows.length; i++) {
      var row = state.offlineRows[i];
      var rk = rowRecordKey(row, map, state.offlineHeaders);
      var email = map.email ? String(row[map.email] || '').trim() : '';
      var res = resolveSupporterId(email);
      var disp = rowDisplayValues(row, map);
      var payRaw = map.payment ? row[map.payment] : '';
      var paymentType = normalizePaymentType(payRaw);
      if (inferPaypalFromRowCells(row, state.offlineHeaders)) paymentType = 'paypal';
      var info = getRecordedInfo(rk, localKeys);
      rows.push({
        row_key: rk,
        supporter_id: res.id != null ? String(res.id) : null,
        email: email || null,
        donor_name: disp.donorName || null,
        amount: disp.amount || null,
        payment_method: disp.payment || null,
        memo: disp.memo || null,
        recorded: info.recorded,
      });
    }
    return rows;
  }

  function onSaveImportDbClick() {
    if (!state.dbConfigured) {
      setStatus('DATABASE_URL is not set on the server.', true);
      return;
    }
    if (!state.offlineRows.length) {
      setStatus('Load an offline file first.', true);
      return;
    }
    var rows = buildSyncRowsPayload();
    setStatus('Saving import to database…', false);
    fetch('/api/donation-rows/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: rows }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (x) {
        if (!x.ok) {
          setStatus((x.j && x.j.error) || 'Save to database failed.', true);
          return;
        }
        setStatus('Saved ' + (x.j.upserted || rows.length) + ' row(s) to Neon.', false);
        scheduleDbLookup();
      })
      .catch(function () {
        setStatus('Save to database failed (network).', true);
      });
  }

  function persistRecordedToApi(rowKeys, recorded, thenFn) {
    if (!state.dbConfigured || !rowKeys.length) {
      if (thenFn) thenFn();
      return;
    }
    fetch('/api/donation-rows/recorded', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: rowKeys.map(function (k) {
          return { rowKey: k, recorded: recorded };
        }),
      }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (x) {
        if (x.ok && x.j && Array.isArray(x.j.results)) {
          for (var i = 0; i < x.j.results.length; i++) {
            var rr = x.j.results[i];
            if (!rr.row_key) continue;
            state.recordedFromDb[rr.row_key] = {
              recorded: !!rr.recorded,
              recordedAt: rr.recorded_at || null,
            };
          }
        }
        if (thenFn) thenFn();
      })
      .catch(function () {
        if (thenFn) thenFn();
      });
  }

  function updateRowFilterSummary(total, visibleCount, totalRecorded, filterVal) {
    var el = $('rowFilterSummary');
    if (!el) return;
    if (!total) {
      el.hidden = true;
      return;
    }
    var label =
      filterVal === 'recorded' ? 'Recorded' : filterVal === 'not_recorded' ? 'Not recorded' : 'All rows';
    el.textContent =
      'Showing ' +
      visibleCount +
      ' of ' +
      total +
      ' rows (filter: ' +
      label +
      '). ' +
      totalRecorded +
      ' marked recorded in this browser.';
    el.hidden = false;
  }

  /** Text block for Donorbox org / donation notes. */
  function buildOrgComments(headers, row, formId) {
    var intro = '';
    try {
      intro = String(($('noteIntro') && $('noteIntro').value) || '').trim();
    } catch (e) {
      intro = '';
    }
    var tsv = rowAsRawTsv(headers, row);
    var body =
      'Parameters:\nform_id: ' +
      formId +
      '\n\nRaw Query String: form_id=' +
      formId +
      '\n\nRaw Data: ' +
      tsv;
    if (intro) return intro + '\n\n' + body;
    return body;
  }

  function fillSelect(sel, headers, preferred) {
    sel.innerHTML = '<option value="">—</option>';
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      var opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      sel.appendChild(opt);
    }
    var cands = Array.isArray(preferred) ? preferred : preferred ? [preferred] : [];
    if (cands.length) {
      var found = findCol(headers, cands);
      if (found) sel.value = found;
    }
  }

  function setStatus(msg, isErr) {
    var el = $('status');
    el.textContent = msg;
    el.style.color = isErr ? '#b00020' : '#1a1a1a';
  }

  function onDonorFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var parsed = parseCSV(text);
      var idx = buildDonorIndex(parsed.headers, parsed.records);
      state.donorRows = parsed.records;
      state.donorByEmail = idx.byEmail;
      state.donorDuplicateEmails = idx.duplicates;
      $('donorCount').textContent = String(idx.byEmail.size) + ' emails mapped (' + parsed.records.length + ' rows)';
      var dupMsg = idx.duplicates.size
        ? ' Duplicate emails: ' +
          idx.duplicates.size +
          ' (using highest numeric Id per email).'
        : '';
      setStatus('Donor export loaded.' + dupMsg, idx.duplicates.size > 0);
      refreshTable();
    };
    reader.readAsText(f);
  }

  function sheetToRecords(workbook) {
    var first = workbook.SheetNames[0];
    var sheet = workbook.Sheets[first];
    var rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: '',
    });
    if (!rows.length) return { headers: [], records: [] };
    return rowsToHeaderRecords(rows);
  }

  function onOfflineFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    var name = f.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      var reader = new FileReader();
      reader.onload = function () {
        var data = new Uint8Array(reader.result);
        var wb = XLSX.read(data, { type: 'array', cellDates: true });
        var parsed = sheetToRecords(wb);
        finishOfflineParsed(parsed);
      };
      reader.readAsArrayBuffer(f);
    } else {
      var r2 = new FileReader();
      r2.onload = function () {
        var parsed = parseCSV(String(r2.result || ''));
        finishOfflineParsed(parsed);
      };
      r2.readAsText(f);
    }
  }

  function finishOfflineParsed(parsed) {
    state.offlineHeaders = parsed.headers;
    state.offlineRows = parsed.records;
    state.recordedFromDb = {};
    $('offlineCount').textContent = String(parsed.records.length) + ' rows';
    applySmartColumnDefaults(parsed.headers, parsed.records);
    setStatus('Offline file loaded. Check column mapping hints below, then Refresh links.', false);
    refreshTable();
    if (state.dbConfigured) scheduleDbLookup();
  }

  function resolveSupporterId(emailVal) {
    var email = String(emailVal || '')
      .trim()
      .toLowerCase();
    if (!email) return { id: null, warn: 'missing email' };
    if (!state.donorByEmail.has(email)) return { id: null, warn: 'no donor match' };
    var id = state.donorByEmail.get(email);
    var warn = state.donorDuplicateEmails.has(email) ? 'duplicate email → max Id' : '';
    return { id: id, warn: warn };
  }

  function getMapping() {
    return {
      email: $('colEmail').value,
      donorName: $('colDonorName') ? $('colDonorName').value : '',
      amount: $('colAmount').value,
      donationDate: $('colDonationDate').value,
      depositDate: $('colDepositDate').value,
      payment: $('colPayment').value,
      check: $('colCheck').value,
      productService: $('colProduct').value,
      memo: $('colMemo') ? $('colMemo').value : '',
    };
  }

  function buildPayloadForRow(row, map) {
    var email = map.email ? row[map.email] : '';
    var amountRaw = map.amount ? row[map.amount] : '';
    var amount = String(amountRaw).replace(/[$,]/g, '').trim();
    var donationDate = map.donationDate ? toISODate(row[map.donationDate]) : '';
    var depositDate = map.depositDate ? toISODate(row[map.depositDate]) : '';
    if (!depositDate && donationDate) depositDate = donationDate;
    var paymentRaw = map.payment ? row[map.payment] : '';
    var paymentType = normalizePaymentType(paymentRaw);
    if (inferPaypalFromRowCells(row, state.offlineHeaders)) {
      paymentType = 'paypal';
    }
    var checkNumber = map.check ? String(row[map.check] || '').trim() : '';
    var productRaw = map.productService ? row[map.productService] : '';
    var donationPurpose = map.productService ? mapProductServiceToPurpose(productRaw) : '';
    var formId = ($('formId').value || '277791').trim();
    var orgComments = buildOrgComments(state.offlineHeaders, row, formId);
    return {
      donationType: paymentType,
      donationDate: donationDate,
      depositDate: depositDate,
      amount: amount,
      orgComments: orgComments,
      checkNumber: checkNumber,
      donationPurpose: donationPurpose,
    };
  }

  function syncSelectAllCheckbox() {
    var master = $('selectAllRows');
    if (!master) return;
    var boxes = document.querySelectorAll('#rowsBody tr:not(.row-filtered-out) input.row-select');
    var checked = document.querySelectorAll(
      '#rowsBody tr:not(.row-filtered-out) input.row-select:checked'
    );
    if (!boxes.length) {
      master.checked = false;
      master.indeterminate = false;
      return;
    }
    master.checked = checked.length === boxes.length;
    master.indeterminate = checked.length > 0 && checked.length < boxes.length;
  }

  function refreshTable() {
    var tbody = $('rowsBody');
    tbody.innerHTML = '';
    state.nextRowIndex = 0;
    state.rowUrls = [];
    var map = getMapping();
    state.formId = ($('formId').value || '277791').trim();
    var recordedKeys = loadRecordedKeys();
    var filterEl = $('rowStatusFilter');
    var filterVal = (filterEl && filterEl.value) || 'all';
    var total = state.offlineRows.length;
    var rowMeta = [];
    var totalRecorded = 0;
    for (var m = 0; m < total; m++) {
      var rowM = state.offlineRows[m];
      var k = rowRecordKey(rowM, map, state.offlineHeaders);
      var info = getRecordedInfo(k, recordedKeys);
      var rec = info.recorded;
      if (rec) totalRecorded++;
      var show =
        filterVal === 'all' ||
        (filterVal === 'recorded' && rec) ||
        (filterVal === 'not_recorded' && !rec);
      rowMeta.push({ key: k, recorded: rec, recordedAt: info.recordedAt, show: show });
    }
    var visibleCount = 0;
    for (var vc = 0; vc < rowMeta.length; vc++) {
      if (rowMeta[vc].show) visibleCount++;
    }
    updateRowFilterSummary(total, visibleCount, totalRecorded, filterVal);

    for (var i = 0; i < state.offlineRows.length; i++) {
      var row = state.offlineRows[i];
      var tr = document.createElement('tr');
      tr.dataset.rowIndex = String(i);
      var meta = rowMeta[i];
      if (!meta.show) tr.classList.add('row-filtered-out');

      var email = map.email ? row[map.email] : '';
      var res = resolveSupporterId(email);
      var payload = buildPayloadForRow(row, map);
      var ph = payloadHash(payload);
      var url = res.id ? buildDonorUrl(res.id, ph.enc) : '';
      state.rowUrls[i] = url;

      var tdSel = document.createElement('td');
      tdSel.className = 'col-sel';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'row-select';
      cb.dataset.rowIndex = String(i);
      cb.setAttribute('aria-label', 'Select row ' + (i + 1));
      tdSel.appendChild(cb);

      var td0 = document.createElement('td');
      td0.textContent = String(i + 1);

      var tdRec = document.createElement('td');
      tdRec.className = 'col-recorded' + (meta.recorded ? ' recorded-yes' : ' recorded-no');
      tdRec.textContent = meta.recorded ? 'Yes' : '—';

      var tdRecAt = document.createElement('td');
      tdRecAt.className = 'col-recorded-at';
      tdRecAt.textContent = meta.recorded && meta.recordedAt ? formatRecordedAt(meta.recordedAt) : '—';

      var disp = rowDisplayValues(row, map);
      var dnClip = clipCell(disp.donorName, 48);
      var tdName = document.createElement('td');
      tdName.className = 'cell-clip';
      tdName.textContent = dnClip.text || '—';
      if (dnClip.title) tdName.title = dnClip.title;

      var tdAmt = document.createElement('td');
      tdAmt.className = 'cell-clip';
      tdAmt.textContent = disp.amount || '—';

      var tdPay = document.createElement('td');
      tdPay.className = 'cell-clip';
      tdPay.textContent = disp.payment || '—';

      var memoClip = clipCell(disp.memo, 64);
      var tdMemo = document.createElement('td');
      tdMemo.className = 'cell-clip';
      tdMemo.textContent = memoClip.text || '—';
      if (memoClip.title) tdMemo.title = memoClip.title;

      var td1 = document.createElement('td');
      td1.textContent = String(email || '');
      var td2 = document.createElement('td');
      td2.textContent = res.id != null ? String(res.id) : '—';
      if (res.warn) td2.title = res.warn;
      var td3 = document.createElement('td');
      if (ph.truncated) td3.textContent = 'note truncated in URL';
      var td4 = document.createElement('td');
      var btnOpen = document.createElement('button');
      btnOpen.type = 'button';
      btnOpen.className = 'open-row';
      btnOpen.textContent = 'Open';
      btnOpen.disabled = !url;
      btnOpen.onclick = function (u) {
        return function () {
          window.open(u, '_blank', 'noopener,noreferrer');
        };
      }(url);
      var btnCopy = document.createElement('button');
      btnCopy.type = 'button';
      btnCopy.textContent = 'Copy URL';
      btnCopy.disabled = !url;
      btnCopy.onclick = function (u) {
        return function () {
          navigator.clipboard.writeText(u).then(
            function () {
              setStatus('URL copied.', false);
            },
            function () {
              setStatus('Copy failed.', true);
            }
          );
        };
      }(url);
      td4.appendChild(btnOpen);
      td4.appendChild(document.createTextNode(' '));
      td4.appendChild(btnCopy);
      tr.appendChild(tdSel);
      tr.appendChild(td0);
      tr.appendChild(tdRec);
      tr.appendChild(tdRecAt);
      tr.appendChild(tdName);
      tr.appendChild(tdAmt);
      tr.appendChild(tdPay);
      tr.appendChild(tdMemo);
      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tbody.appendChild(tr);
    }
    syncSelectAllCheckbox();
    updateMappingHints();
  }

  function openNextRowInOrder() {
    var tbody = $('rowsBody');
    var rows = tbody.querySelectorAll('tr');
    var started = state.nextRowIndex;
    while (state.nextRowIndex < rows.length) {
      var tr = rows[state.nextRowIndex];
      state.nextRowIndex++;
      if (tr.classList.contains('row-filtered-out')) continue;
      var btnOpen = tr.querySelector('button.open-row');
      if (btnOpen && !btnOpen.disabled) {
        btnOpen.click();
        setStatus('Opened row #' + (parseInt(tr.dataset.rowIndex, 10) + 1) + '.', false);
        return;
      }
    }
    state.nextRowIndex = 0;
    setStatus('No further rows with a resolvable supporter Id (searched from row ' + (started + 1) + '). Counter reset.', false);
  }

  function openUrlsInTabs(urls) {
    var list = urls.filter(Boolean);
    if (!list.length) return 0;
    var delayMs = 280;
    for (var j = 0; j < list.length; j++) {
      (function (u, k) {
        setTimeout(function () {
          window.open(u, '_blank', 'noopener,noreferrer');
        }, k * delayMs);
      })(list[j], j);
    }
    return list.length;
  }

  function onSelectAllRowsChange(ev) {
    var on = ev.target.checked;
    document.querySelectorAll('#rowsBody tr:not(.row-filtered-out) input.row-select').forEach(function (cb) {
      cb.checked = on;
    });
  }

  function onSelectAllValidClick() {
    document.querySelectorAll('#rowsBody tr:not(.row-filtered-out)').forEach(function (tr) {
      var idx = parseInt(tr.dataset.rowIndex, 10);
      var cb = tr.querySelector('input.row-select');
      if (!cb || isNaN(idx)) return;
      cb.checked = !!state.rowUrls[idx];
    });
    syncSelectAllCheckbox();
    setStatus('Selected all rows with valid supporter links.', false);
  }

  function onClearSelectionClick() {
    document.querySelectorAll('#rowsBody input.row-select').forEach(function (cb) {
      cb.checked = false;
    });
    var master = $('selectAllRows');
    if (master) {
      master.checked = false;
      master.indeterminate = false;
    }
    setStatus('Selection cleared.', false);
  }

  function onOpenSelectedTabsClick() {
    var urls = [];
    document.querySelectorAll('input.row-select:checked').forEach(function (cb) {
      var idx = parseInt(cb.dataset.rowIndex, 10);
      if (!isNaN(idx) && state.rowUrls[idx]) urls.push(state.rowUrls[idx]);
    });
    if (!urls.length) {
      setStatus('Select at least one row with a valid link (checkbox), or use “Select all with valid links”.', true);
      return;
    }
    var n = openUrlsInTabs(urls);
    setStatus('Queued ' + n + ' tab(s). Allow pop-ups for this page if the browser blocks some.', false);
  }

  function onOpenAllValidTabsClick() {
    var urls = [];
    document.querySelectorAll('#rowsBody tr:not(.row-filtered-out)').forEach(function (tr) {
      var idx = parseInt(tr.dataset.rowIndex, 10);
      if (!isNaN(idx) && state.rowUrls[idx]) urls.push(state.rowUrls[idx]);
    });
    if (!urls.length) {
      setStatus('No visible rows with a resolvable supporter Id (check the filter).', true);
      return;
    }
    var n = openUrlsInTabs(urls);
    setStatus('Queued ' + n + ' tab(s) (visible rows with links). Allow pop-ups if some are blocked.', false);
  }

  function getSelectedRowIndexes() {
    var out = [];
    document.querySelectorAll('#rowsBody input.row-select:checked').forEach(function (cb) {
      var idx = parseInt(cb.dataset.rowIndex, 10);
      if (!isNaN(idx)) out.push(idx);
    });
    return out;
  }

  function onMarkRecordedClick() {
    var idxs = getSelectedRowIndexes();
    if (!idxs.length) {
      setStatus('Select at least one row (checkbox), then mark as recorded.', true);
      return;
    }
    var keys = loadRecordedKeys();
    var map = getMapping();
    var rowKeys = [];
    for (var i = 0; i < idxs.length; i++) {
      var row = state.offlineRows[idxs[i]];
      if (!row) continue;
      var rk = rowRecordKey(row, map, state.offlineHeaders);
      keys[rk] = 1;
      rowKeys.push(rk);
    }
    saveRecordedKeys(keys);
    persistRecordedToApi(rowKeys, true, function () {
      setStatus(
        'Marked ' +
          idxs.length +
          ' row(s) as recorded' +
          (state.dbConfigured ? ' (database updated where rows exist).' : ' (this browser).'),
        false
      );
      refreshTable();
    });
  }

  function onMarkUnrecordedClick() {
    var idxs = getSelectedRowIndexes();
    if (!idxs.length) {
      setStatus('Select at least one row (checkbox), then clear recorded.', true);
      return;
    }
    var keys = loadRecordedKeys();
    var map = getMapping();
    var rowKeys = [];
    for (var i = 0; i < idxs.length; i++) {
      var row = state.offlineRows[idxs[i]];
      if (!row) continue;
      var rk = rowRecordKey(row, map, state.offlineHeaders);
      delete keys[rk];
      rowKeys.push(rk);
    }
    saveRecordedKeys(keys);
    persistRecordedToApi(rowKeys, false, function () {
      setStatus('Cleared recorded for ' + idxs.length + ' row(s).', false);
      refreshTable();
    });
  }

  function wire() {
    updateDbHint();
    $('donorFile').addEventListener('change', onDonorFile);
    $('offlineFile').addEventListener('change', onOfflineFile);
    $('btnRefresh').addEventListener('click', function () {
      refreshTable();
      updateMappingHints();
      setStatus('Links refreshed.', false);
    });
    $('btnOpenNext').addEventListener('click', openNextRowInOrder);
    var selAll = $('selectAllRows');
    if (selAll) selAll.addEventListener('change', onSelectAllRowsChange);
    var tbody = $('rowsBody');
    if (tbody) {
      tbody.addEventListener('change', function (ev) {
        if (ev.target && ev.target.classList && ev.target.classList.contains('row-select')) {
          syncSelectAllCheckbox();
        }
      });
    }
    var bSel = $('btnSelectAllValid');
    if (bSel) bSel.addEventListener('click', onSelectAllValidClick);
    var bClr = $('btnClearSelection');
    if (bClr) bClr.addEventListener('click', onClearSelectionClick);
    var bOS = $('btnOpenSelectedTabs');
    if (bOS) bOS.addEventListener('click', onOpenSelectedTabsClick);
    var bOA = $('btnOpenAllValidTabs');
    if (bOA) bOA.addEventListener('click', onOpenAllValidTabsClick);
    var bMR = $('btnMarkRecorded');
    if (bMR) bMR.addEventListener('click', onMarkRecordedClick);
    var bMU = $('btnMarkUnrecorded');
    if (bMU) bMU.addEventListener('click', onMarkUnrecordedClick);
    var bSaveDb = $('btnSaveImportDb');
    if (bSaveDb) bSaveDb.addEventListener('click', onSaveImportDbClick);
    var rowFilter = $('rowStatusFilter');
    if (rowFilter) rowFilter.addEventListener('change', refreshTable);
    fetch('/api/db-status')
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        state.dbConfigured = !!(j && j.configured);
        updateDbHint();
        if (state.dbConfigured && state.offlineRows.length) scheduleDbLookup();
      })
      .catch(function () {
        state.dbConfigured = false;
        updateDbHint();
      });
    $('formId').addEventListener('change', refreshTable);
    var noteIntro = $('noteIntro');
    if (noteIntro) {
      try {
        noteIntro.value = localStorage.getItem('dbOfflineNoteIntro') || '';
      } catch (e) {
        noteIntro.value = '';
      }
      noteIntro.addEventListener('input', function () {
        try {
          localStorage.setItem('dbOfflineNoteIntro', noteIntro.value);
        } catch (e2) {
          /* ignore */
        }
        refreshTable();
      });
    }
    [
      'colEmail',
      'colAmount',
      'colDonationDate',
      'colDepositDate',
      'colPayment',
      'colCheck',
      'colProduct',
      'colDonorName',
      'colMemo',
    ].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', refreshTable);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
