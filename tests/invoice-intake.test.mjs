import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const IDEMPOTENCY_START = "/* invoice-idempotency:start */";
const IDEMPOTENCY_END = "/* invoice-idempotency:end */";

function memoryStorage({ rejectWrites = false } = {}) {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (rejectWrites) throw new Error("storage blocked");
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
}

function loadIdempotency({ sessionStorage, localStorage, requestIds }) {
  const start = html.indexOf(IDEMPOTENCY_START);
  const end = html.indexOf(IDEMPOTENCY_END, start);
  assert.ok(start >= 0 && end > start, "missing idempotency source markers");
  const source = html.slice(start + IDEMPOTENCY_START.length, end);
  const field = { value: "" };
  let requestIdCalls = 0;
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    sessionStorage,
    localStorage,
    document: {
      getElementById(id) {
        assert.equal(id, "invoiceRequestId");
        return field;
      },
    },
    nextRequestId() {
      const value = requestIds[requestIdCalls];
      requestIdCalls += 1;
      if (!value) throw new Error("unexpected request id generation");
      return value;
    },
  };
  vm.runInNewContext(
    `const INVOICE_SOURCE_SITE='test.example';function createInvoiceRequestId(){return globalThis.nextRequestId()}\n${source}\n` +
      "globalThis.__api={createInvoicePayloadFingerprint,getOrCreateInvoiceRequestId,clearInvoiceRequestId,readPendingInvoiceRequest_};",
    sandbox,
  );
  return { api: sandbox.__api, field, get requestIdCalls() { return requestIdCalls; } };
}

test("guest request uses the v4 canonical APT7 contract", () => {
  for (const value of [
    "action:'guest_request'", "schema_version:'4'", "property_code:'APT7'",
    "const INVOICE_SOURCE_SITE='apartman7.github.io'", "guest_name:", "address:",
    "company_id:", "tax_id:", "vat_id:", "guest_email:", "booking_id:",
    "note:", "email_confirmed:", "electronic_delivery_consent:", "_honey:",
  ]) assert.ok(html.includes(value), `missing ${value}`);
  assert.doesNotMatch(html, /formsubmit\.co/i);
});

test("iframe transport accepts only a matching Google ACK", () => {
  for (const value of [
    "https://script.google.com/macros/s/AKfycbwD7RRz5nJdp6FsU3vL1CTgsPNwXPuCrx1ad9JMBa8LQNDYZCTltMAtN48IRzb8NsYo/exec", "booking-invoice-intake-v1",
    "application/x-www-form-urlencoded", "allow-scripts allow-same-origin",
    "isIntakeAckSource(event.source,frame.contentWindow)",
    "isAllowedIntakeAckOrigin(event.origin)", "data.ack_nonce!==nonce",
    "data.ok===true?finish(true,data)", "form.remove();frame.remove()",
  ]) assert.ok(html.includes(value), `missing ${value}`);
  assert.doesNotMatch(html, /REPLACE_WITH_PUBLIC_INTAKE_DEPLOYMENT_ID/);
});

test("request id and pending fingerprint are cleared only after positive ACK", () => {
  const awaitIndex = html.indexOf("await postInvoiceRequest(data)");
  const clearIndex = html.indexOf("clearInvoiceRequestId(requestId,payloadFingerprint)", awaitIndex);
  assert.ok(awaitIndex >= 0 && clearIndex > awaitIndex);
  assert.equal((html.match(/clearInvoiceRequestId\(requestId,payloadFingerprint\)/g) || []).length, 1);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new Function(source);
});

test("identical payload reuses request id after reload, changed payload gets a new id, ACK clears it", async () => {
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  const ids = [
    "web-11111111111111111111111111111111",
    "web-22222222222222222222222222222222",
    "web-33333333333333333333333333333333",
  ];
  const now = 1900000000000;
  const first = loadIdempotency({ sessionStorage, localStorage, requestIds: ids });
  const payload = { guest_email: "host@example.com", guest_name: "Test", request_id: "" };
  const fingerprint = await first.api.createInvoicePayloadFingerprint(payload);
  const reordered = await first.api.createInvoicePayloadFingerprint({ request_id: "ignored", guest_name: "Test", guest_email: "host@example.com" });
  assert.equal(fingerprint, reordered, "request_id and key order must not change the fingerprint");
  const firstId = first.api.getOrCreateInvoiceRequestId(fingerprint, now);
  assert.equal(firstId, ids[0]);
  assert.equal(first.requestIdCalls, 1);

  const reload = loadIdempotency({ sessionStorage: memoryStorage(), localStorage, requestIds: ids.slice(1) });
  assert.equal(reload.api.getOrCreateInvoiceRequestId(fingerprint, now + 1), firstId);
  assert.equal(reload.requestIdCalls, 0, "reload must not generate another id for the same payload");

  const changedFingerprint = await reload.api.createInvoicePayloadFingerprint({ ...payload, guest_name: "Changed" });
  const changedId = reload.api.getOrCreateInvoiceRequestId(changedFingerprint, now + 2);
  assert.equal(changedId, ids[1]);
  reload.api.clearInvoiceRequestId(firstId, fingerprint, now + 3);
  assert.equal(reload.field.value, changedId, "stale ACK must not clear a newer pending request");
  assert.ok(localStorage.getItem("booking-invoice-pending-v1:test.example"));

  reload.api.clearInvoiceRequestId(changedId, changedFingerprint, now + 4);
  assert.equal(reload.field.value, "");
  assert.equal(localStorage.getItem("booking-invoice-pending-v1:test.example"), null);
  const afterAck = loadIdempotency({ sessionStorage: memoryStorage(), localStorage, requestIds: ids.slice(2) });
  assert.equal(afterAck.api.getOrCreateInvoiceRequestId(changedFingerprint, now + 5), ids[2]);
});

test("blocked localStorage falls back to reload-safe sessionStorage without storing PII", async () => {
  const blockedLocal = memoryStorage({ rejectWrites: true });
  const sessionStorage = memoryStorage();
  const ids = ["web-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "web-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
  const first = loadIdempotency({ sessionStorage, localStorage: blockedLocal, requestIds: ids });
  const payload = { guest_name: "Sensitive Guest", guest_email: "sensitive@example.com", request_id: "" };
  const fingerprint = await first.api.createInvoicePayloadFingerprint(payload);
  const requestId = first.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000);
  const stored = sessionStorage.getItem("booking-invoice-pending-v1:test.example");
  assert.ok(stored);
  assert.doesNotMatch(stored, /Sensitive Guest|sensitive@example\.com/);

  const reload = loadIdempotency({ sessionStorage, localStorage: blockedLocal, requestIds: ids.slice(1) });
  assert.equal(reload.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000001), requestId);
  assert.equal(reload.requestIdCalls, 0);
});

test("request preparation fails closed when no persistent storage accepts the pending id", async () => {
  const blockedSession = memoryStorage({ rejectWrites: true });
  const blockedLocal = memoryStorage({ rejectWrites: true });
  const instance = loadIdempotency({
    sessionStorage: blockedSession,
    localStorage: blockedLocal,
    requestIds: ["web-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
  });
  const fingerprint = await instance.api.createInvoicePayloadFingerprint({ guest_name: "Test", request_id: "" });
  assert.throws(
    () => instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
    /pending-storage-unavailable/,
  );
  assert.equal(instance.field.value, "", "failed persistence must not prepare an id for POST");
  assert.equal(instance.api.readPendingInvoiceRequest_(1900000000001), null);
});
