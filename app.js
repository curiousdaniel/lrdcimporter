/* global XLSX */
(function () {
  'use strict';

  var MAX_HASH_PAYLOAD_CHARS = 7200;

  var state = {
    donorRows: [],
    donorByEmail: new Map(),
    donorDuplicateEmails: new Set(),
    offlineHeaders: [],
    offlineRows: [],
    formId: '277791',
    nextRowIndex: 0,
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
    var headers = rows[0].map(function (h) {
      return String(h).trim();
    });
    var records = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      if (!cells.length || (cells.length === 1 && cells[0] === '')) continue;
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c]] = cells[c] != null ? String(cells[c]) : '';
      }
      records.push(obj);
    }
    return { headers: headers, records: records };
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
    var note = data.orgComments || '';
    var base = Object.assign({}, data);
    var safety = 0;
    while (safety++ < 40) {
      base.orgComments = note;
      var enc = encodePayload(base);
      if (enc.length <= MAX_HASH_PAYLOAD_CHARS) return { enc: enc, truncated: note !== (data.orgComments || '') };
      note =
        note.slice(0, Math.floor(note.length * 0.75)) +
        '\n[... truncated for browser URL length; full row is in your offline file ...]';
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

  function rowRawNote(headers, rowObj) {
    return JSON.stringify(rowObj, null, 2);
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
    var headers = rows[0].map(function (h) {
      return String(h).trim();
    });
    var records = [];
    for (var r = 1; r < rows.length; r++) {
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
        var key = headers[j] || 'Column' + j;
        var cell = cells[j];
        if (cell instanceof Date) obj[key] = cell;
        else obj[key] = cell != null ? String(cell) : '';
      }
      records.push(obj);
    }
    return { headers: headers, records: records };
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
    $('offlineCount').textContent = String(parsed.records.length) + ' rows';
    var hdrs = parsed.headers;
    fillSelect($('colEmail'), hdrs, ['email', 'e-mail', 'donor email']);
    fillSelect($('colAmount'), hdrs, ['amount', 'donation amount', 'gift amount']);
    fillSelect($('colDonationDate'), hdrs, [
      'donation date',
      'donation_date',
      'date donated',
      'gift date',
      'date',
    ]);
    fillSelect($('colDepositDate'), hdrs, [
      'deposit date',
      'deposit_date',
      'bank date',
      'date deposited',
    ]);
    fillSelect($('colPayment'), hdrs, [
      'payment',
      'payment type',
      'method',
      'donation_type',
      'type',
    ]);
    fillSelect($('colCheck'), hdrs, ['check', 'check number', 'check #', 'check_no', 'check no']);
    setStatus('Offline file loaded. Map columns if needed, then refresh links.', false);
    refreshTable();
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
      amount: $('colAmount').value,
      donationDate: $('colDonationDate').value,
      depositDate: $('colDepositDate').value,
      payment: $('colPayment').value,
      check: $('colCheck').value,
    };
  }

  function buildPayloadForRow(row, map) {
    var email = map.email ? row[map.email] : '';
    var amountRaw = map.amount ? row[map.amount] : '';
    var amount = String(amountRaw).replace(/[$,]/g, '').trim();
    var donationDate = map.donationDate ? toISODate(row[map.donationDate]) : '';
    var depositDate = map.depositDate ? toISODate(row[map.depositDate]) : '';
    var paymentRaw = map.payment ? row[map.payment] : '';
    var checkNumber = map.check ? String(row[map.check] || '').trim() : '';
    var orgComments = rowRawNote(state.offlineHeaders, row);
    return {
      donationType: String(paymentRaw || '').trim(),
      donationDate: donationDate,
      depositDate: depositDate,
      amount: amount,
      orgComments: orgComments,
      checkNumber: checkNumber,
    };
  }

  function refreshTable() {
    var tbody = $('rowsBody');
    tbody.innerHTML = '';
    state.nextRowIndex = 0;
    var map = getMapping();
    state.formId = ($('formId').value || '277791').trim();
    for (var i = 0; i < state.offlineRows.length; i++) {
      var row = state.offlineRows[i];
      var tr = document.createElement('tr');
      tr.dataset.rowIndex = String(i);
      var email = map.email ? row[map.email] : '';
      var res = resolveSupporterId(email);
      var payload = buildPayloadForRow(row, map);
      var ph = payloadHash(payload);
      var url = res.id ? buildDonorUrl(res.id, ph.enc) : '';

      var td0 = document.createElement('td');
      td0.textContent = String(i + 1);
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
      tr.appendChild(td0);
      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tbody.appendChild(tr);
    }
  }

  function openNextRowInOrder() {
    var tbody = $('rowsBody');
    var rows = tbody.querySelectorAll('tr');
    var started = state.nextRowIndex;
    while (state.nextRowIndex < rows.length) {
      var tr = rows[state.nextRowIndex];
      var btnOpen = tr.querySelector('button');
      state.nextRowIndex++;
      if (btnOpen && !btnOpen.disabled) {
        btnOpen.click();
        setStatus('Opened row #' + (parseInt(tr.dataset.rowIndex, 10) + 1) + '.', false);
        return;
      }
    }
    state.nextRowIndex = 0;
    setStatus('No further rows with a resolvable supporter Id (searched from row ' + (started + 1) + '). Counter reset.', false);
  }

  function wire() {
    $('donorFile').addEventListener('change', onDonorFile);
    $('offlineFile').addEventListener('change', onOfflineFile);
    $('btnRefresh').addEventListener('click', function () {
      refreshTable();
      setStatus('Links refreshed.', false);
    });
    $('btnOpenNext').addEventListener('click', openNextRowInOrder);
    $('formId').addEventListener('change', refreshTable);
    [
      'colEmail',
      'colAmount',
      'colDonationDate',
      'colDepositDate',
      'colPayment',
      'colCheck',
    ].forEach(function (id) {
      $(id).addEventListener('change', refreshTable);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
