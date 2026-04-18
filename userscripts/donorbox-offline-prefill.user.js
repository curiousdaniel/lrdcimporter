// ==UserScript==
// @name         Donorbox offline donation prefill
// @namespace    lrdc-offline-importer
// @version      1.0.2
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
 * - Org note:      textarea#donation_org_comments
 * - Check # (opt): input#donation_offline_donation_additional_detail_attributes_check_number
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

  /** Map launcher keys plus alternates (nested PayPal-style exports, manual tests). */
  function normalizePayload(data) {
    if (!data || typeof data !== 'object') return null;
    var d = flattenPayload(data);
    return {
      donationType: String(
        d.donationType ||
          d.payment_type ||
          d.paymentType ||
          d.payment ||
          d.type ||
          d.donation_type ||
          ''
      ),
      donationDate: toISODate(
        d.donationDate || d.donation_date || d.date || d.giftDate || d.transaction_date || ''
      ),
      depositDate: toISODate(
        d.depositDate || d.deposit_date || d.bankDate || d.date_deposited || ''
      ),
      amount: d.amount != null && d.amount !== '' ? String(d.amount) : '',
      orgComments: String(
        d.orgComments ||
          d.notes ||
          d.note ||
          d.comment ||
          d.org_comment ||
          d.memo ||
          ''
      ),
      checkNumber: String(
        d.checkNumber != null && d.checkNumber !== ''
          ? d.checkNumber
          : d.check_number != null && d.check_number !== ''
            ? d.check_number
            : d.check != null && d.check !== ''
              ? d.check
              : ''
      ),
    };
  }

  function dispatchAll(el) {
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setSelectValue(sel, value) {
    if (!sel || value == null || value === '') return;
    var v = String(value).toLowerCase().trim();
    var opt = Array.prototype.find.call(sel.options, function (o) {
      return o.value.toLowerCase() === v;
    });
    if (!opt) {
      opt = Array.prototype.find.call(sel.options, function (o) {
        return o.textContent.toLowerCase().trim() === v;
      });
    }
    if (opt && opt.value) {
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
    var checkNum = document.querySelector(
      '#donation_offline_donation_additional_detail_attributes_check_number'
    );

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
    if (data.orgComments != null && data.orgComments !== '' && orgComments) {
      orgComments.value = String(data.orgComments);
      dispatchAll(orgComments);
    }
    if (data.checkNumber != null && data.checkNumber !== '' && checkNum) {
      checkNum.value = String(data.checkNumber);
      dispatchAll(checkNum);
    }
  }

  function clearHashFromUrl() {
    var url = location.pathname + location.search;
    history.replaceState(null, '', url);
  }

  function tryDecodeAndApply() {
    var parsed = decodePayload(location.hash);
    if (!parsed) return;
    var data = normalizePayload(parsed);
    if (!data) return;
    var attempts = 0;
    function tryApply() {
      attempts++;
      var ready = document.querySelector('#amount');
      if (!ready && attempts < 100) {
        setTimeout(tryApply, 100);
        return;
      }
      if (!ready) {
        console.warn('[Donorbox prefill] Form not detected; leaving URL hash unchanged.');
        return;
      }
      apply(data);
      clearHashFromUrl();
      console.info('[Donorbox prefill] Applied offline payload.');
    }
    tryApply();
  }

  tryDecodeAndApply();
  window.addEventListener('hashchange', tryDecodeAndApply, false);
  document.addEventListener('turbo:load', tryDecodeAndApply, false);
  document.addEventListener('turbolinks:load', tryDecodeAndApply, false);
})();
