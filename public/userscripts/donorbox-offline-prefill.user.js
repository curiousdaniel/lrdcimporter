// ==UserScript==
// @name         Donorbox offline donation prefill
// @namespace    lrdc-offline-importer
// @version      1.0.6
// @description  Fills the Donorbox org-admin offline donation form from #dbOffline= / #!dbOffline= base64 JSON (flat or nested donation object). You must be logged in; complete captcha and submit manually if required.
// @match        https://donorbox.org/org_admin/supporters/*/donor_donations/new*
// @match        https://*.donorbox.org/org_admin/supporters/*/donor_donations/new*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * Form field map (from Donorbox org-admin offline donation form HTML):
 * - Payment type:  select#donation_donation_type
 * - Donation date: input#donation_donation_date
 * - Deposit date: input#donation_offline_donation_additional_detail_attributes_deposit_date
 * - Amount:        input#amount
 * - Org / donation notes: textarea#donation_org_comments and #donation_comment when present
 * - Check # (opt): input#donation_offline_donation_additional_detail_attributes_check_number
 * - Purpose of donation: select next to label “The Purpose of Your Donation:” (or donation form / campaign select fallbacks), option text must match launcher payload
 */

(function () {
  'use strict';

  var HASH_PREFIX = 'dbOffline=';

  function decodePayload(hash) {
    if (!hash || hash.charAt(0) !== '#') return null;
    var raw = hash.slice(1).replace(/^!+/, '');
    var idx = raw.indexOf(HASH_PREFIX);
    if (idx === -1) return null;
    var enc = raw.slice(idx + HASH_PREFIX.length);
    if (!enc) return null;
    enc = enc.trim();
    var amp = enc.indexOf('&');
    if (amp !== -1) enc = enc.slice(0, amp);
    try {
      enc = decodeURIComponent(enc);
    } catch (e0) {
      /* fragment may already be decoded */
    }
    enc = enc.replace(/\s/g, '');
    try {
      var b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      var json;
      if (typeof TextDecoder !== 'undefined') {
        var u8 = new Uint8Array(bin.length);
        for (var bi = 0; bi < bin.length; bi++) u8[bi] = bin.charCodeAt(bi) & 0xff;
        json = new TextDecoder('utf-8').decode(u8);
      } else {
        json = decodeURIComponent(escape(bin));
      }
      return JSON.parse(json);
    } catch (e) {
      console.warn('[Donorbox prefill] Invalid payload', e);
      return null;
    }
  }

  /** Merge nested objects (e.g. { donor: {...}, donation: { amount, notes, ... } }). */
  function flattenPayload(data) {
    if (!data || typeof data !== 'object') return data;
    var out = Object.assign({}, data);
    ['donation', 'donor_donation', 'offline_donation', 'record', 'payload'].forEach(function (k) {
      if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) {
        Object.assign(out, data[k]);
      }
    });
    return out;
  }

  function toISODate(val) {
    if (val == null || val === '') return '';
    if (val instanceof Date && !isNaN(val.getTime())) {
      var y = val.getFullYear();
      var m = String(val.getMonth() + 1).padStart(2, '0');
      var d = String(val.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
    var s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return mdy[3] + '-' + mdy[1].padStart(2, '0') + '-' + mdy[2].padStart(2, '0');
    var t = Date.parse(s);
    if (!isNaN(t)) {
      var d2 = new Date(t);
      return (
        d2.getFullYear() +
        '-' +
        String(d2.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d2.getDate()).padStart(2, '0')
      );
    }
    return '';
  }

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

  /** Map launcher keys plus alternates (nested PayPal-style exports, manual tests). */
  function normalizePayload(data) {
    if (!data || typeof data !== 'object') return null;
    var d = flattenPayload(data);
    var rawType = String(
      d.donationType ||
        d.payment_type ||
        d.paymentType ||
        d.payment ||
        d.type ||
        d.donation_type ||
        ''
    );
    var donationDate = toISODate(
      d.donationDate || d.donation_date || d.date || d.giftDate || d.transaction_date || ''
    );
    var depositDate = toISODate(
      d.depositDate || d.deposit_date || d.bankDate || d.date_deposited || ''
    );
    if (!depositDate && donationDate) depositDate = donationDate;
    var donationType = normalizePaymentType(rawType);
    try {
      var blob = JSON.stringify(d).toLowerCase();
      if (blob.indexOf('paypal') !== -1 && donationType !== 'credit_card') {
        donationType = 'paypal';
      }
    } catch (eBlob) {
      /* ignore */
    }
    return {
      donationType: donationType,
      donationDate: donationDate,
      depositDate: depositDate,
      amount: d.amount != null && d.amount !== '' ? String(d.amount) : '',
      orgComments: String(
        d.orgComments ||
          d.notes ||
          d.note ||
          d.comment ||
          d.org_comment ||
          d.memo ||
          ''
      ).trim(),
      checkNumber: String(
        d.checkNumber != null && d.checkNumber !== ''
          ? d.checkNumber
          : d.check_number != null && d.check_number !== ''
            ? d.check_number
            : d.check != null && d.check !== ''
              ? d.check
              : ''
      ),
      donationPurpose: String(
        d.donationPurpose ||
          d.purpose ||
          d.donation_purpose ||
          d.purposeLabel ||
          d.purpose_of_donation ||
          ''
      ).trim(),
    };
  }

  function dispatchAll(el) {
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setSelectValue(sel, value) {
    if (!sel || value == null || value === '') return;
    var v = normalizePaymentType(value) || String(value).toLowerCase().trim();
    if (!v) return;
    var opt = Array.prototype.find.call(sel.options, function (o) {
      return o.value.toLowerCase() === v;
    });
    if (!opt) {
      opt = Array.prototype.find.call(sel.options, function (o) {
        return o.textContent.toLowerCase().trim() === v;
      });
    }
    if (!opt && v.length >= 4) {
      opt = Array.prototype.find.call(sel.options, function (o) {
        return o.textContent.toLowerCase().indexOf(v) !== -1;
      });
    }
    if (opt && opt.value) {
      sel.value = opt.value;
      dispatchAll(sel);
    }
  }

  /** “The Purpose of Your Donation:” and similar selects use numeric values; match by visible option label. */
  function findPurposeSelect() {
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      var t = labels[i].textContent || '';
      if (/purpose\s+of\s+your\s+donation/i.test(t)) {
        var fid = labels[i].getAttribute('for');
        if (fid) {
          var byId = document.getElementById(fid);
          if (byId && byId.tagName === 'SELECT') return byId;
        }
        var wrap = labels[i].closest ? labels[i].closest('div') : null;
        if (!wrap) wrap = labels[i].parentElement;
        if (wrap) {
          var s = wrap.querySelector('select');
          if (s) return s;
        }
      }
    }
    return (
      document.querySelector('select[name="donation[donation_form_id]"]') ||
      document.querySelector('#donation_donation_form_id') ||
      document.querySelector('select[name="donation[campaign_id]"]') ||
      document.querySelector('#donation_campaign_id')
    );
  }

  function setPurposeSelect(sel, labelText) {
    if (!sel || labelText == null) return;
    var want = String(labelText).trim();
    if (!want) return;
    var wantLower = want.toLowerCase();
    var opt = Array.prototype.find.call(sel.options, function (o) {
      return (o.textContent || '').trim() === want;
    });
    if (!opt) {
      opt = Array.prototype.find.call(sel.options, function (o) {
        return (o.textContent || '').trim().toLowerCase() === wantLower;
      });
    }
    if (!opt) {
      opt = Array.prototype.find.call(sel.options, function (o) {
        return (o.textContent || '').trim().toLowerCase().indexOf(wantLower) !== -1;
      });
    }
    if (opt && opt.value != null && opt.value !== '') {
      sel.value = opt.value;
      dispatchAll(sel);
    }
  }

  function apply(data) {
    var typeSel = document.querySelector('#donation_donation_type');
    var donationDate = document.querySelector('#donation_donation_date');
    var depositDate = document.querySelector(
      '#donation_offline_donation_additional_detail_attributes_deposit_date'
    );
    var amount = document.querySelector('#amount');
    var orgComments = document.querySelector('#donation_org_comments');
    var donorComment = document.querySelector('#donation_comment');
    var checkNum = document.querySelector(
      '#donation_offline_donation_additional_detail_attributes_check_number'
    );
    var purposeSel = findPurposeSelect();

    if (data.donationType != null && data.donationType !== '') {
      setSelectValue(typeSel, data.donationType);
    }
    if (data.donationDate != null && data.donationDate !== '' && donationDate) {
      donationDate.value = data.donationDate;
      dispatchAll(donationDate);
    }
    if (data.depositDate != null && data.depositDate !== '' && depositDate) {
      depositDate.value = data.depositDate;
      dispatchAll(depositDate);
    }
    if (data.amount != null && data.amount !== '' && amount) {
      amount.value = String(data.amount);
      dispatchAll(amount);
    }
    if (data.orgComments != null && data.orgComments !== '') {
      var noteText = String(data.orgComments);
      if (orgComments) {
        orgComments.value = noteText;
        dispatchAll(orgComments);
      }
      if (donorComment) {
        donorComment.value = noteText;
        dispatchAll(donorComment);
      }
    }
    if (data.checkNumber != null && data.checkNumber !== '' && checkNum) {
      checkNum.value = String(data.checkNumber);
      dispatchAll(checkNum);
    }
    if (data.donationPurpose != null && data.donationPurpose !== '' && purposeSel) {
      setPurposeSelect(purposeSel, data.donationPurpose);
    }
  }

  function clearHashFromUrl() {
    var url = location.pathname + location.search;
    history.replaceState(null, '', url);
  }

  /** Cancels stale delayed/repeat applies when navigating or hash changes. */
  var prefillRunToken = null;

  /**
   * Donorbox initializes defaults after paint. We wait for the form, add a short pause,
   * then apply several times so our values win over late-running framework code.
   */
  function tryDecodeAndApply() {
    var parsed = decodePayload(location.hash);
    if (!parsed) {
      prefillRunToken = null;
      return;
    }
    var data = normalizePayload(parsed);
    if (!data) return;

    var myToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    prefillRunToken = myToken;

    function waitForAmountField(cb) {
      var tries = 0;
      (function poll() {
        if (prefillRunToken !== myToken) return;
        if (document.querySelector('#amount')) {
          if (prefillRunToken !== myToken) return;
          cb();
          return;
        }
        if (++tries > 120) {
          console.warn('[Donorbox prefill] Form not detected; leaving URL hash unchanged.');
          if (prefillRunToken === myToken) prefillRunToken = null;
          return;
        }
        setTimeout(poll, 100);
      })();
    }

    function afterPageQuiet(cb) {
      function go() {
        setTimeout(function () {
          if (prefillRunToken !== myToken) return;
          cb();
        }, 450);
      }
      if (document.readyState === 'complete') {
        go();
        return;
      }
      window.addEventListener('load', function once() {
        window.removeEventListener('load', once);
        go();
      });
    }

    waitForAmountField(function () {
      afterPageQuiet(function () {
        if (prefillRunToken !== myToken) return;
        var offsetsMs = [0, 700, 1600, 2800, 4200, 5800];
        offsetsMs.forEach(function (ms, idx) {
          setTimeout(function () {
            if (prefillRunToken !== myToken) return;
            if (!document.querySelector('#amount')) return;
            apply(data);
            if (idx === offsetsMs.length - 1) {
              clearHashFromUrl();
              if (prefillRunToken === myToken) prefillRunToken = null;
              console.info('[Donorbox prefill] Applied offline payload (delayed + repeated).');
            }
          }, ms);
        });
      });
    });
  }

  tryDecodeAndApply();
  window.addEventListener('hashchange', tryDecodeAndApply, false);
  document.addEventListener('turbo:load', tryDecodeAndApply, false);
  document.addEventListener('turbolinks:load', tryDecodeAndApply, false);
})();
