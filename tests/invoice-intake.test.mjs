import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const IDEMPOTENCY_START = "/* invoice-idempotency:start */";
const IDEMPOTENCY_END = "/* invoice-idempotency:end */";

function memoryStorage({ rejectReads = false, rejectWrites = false, rejectRemoves = false } = {}) {
  const values = new Map();
  return {
    getItem(key) {
      if (rejectReads) throw new Error("storage blocked");
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (rejectWrites) throw new Error("storage blocked");
      values.set(key, String(value));
    },
    removeItem(key) {
      if (rejectRemoves) throw new Error("storage blocked");
      values.delete(key);
    },
  };
}

function memoryLocks() {
  const tails = new Map();
  return {
    request(name, options, callback) {
      assert.equal(options.mode, "exclusive");
      const prior = tails.get(name) || Promise.resolve();
      const run = prior.catch(() => {}).then(() => callback());
      const tail = run.then(() => undefined, () => undefined);
      tails.set(name, tail);
      return run.finally(() => {
        if (tails.get(name) === tail) tails.delete(name);
      });
    },
  };
}

function loadIdempotency({ localStorage, requestIds, locks = memoryLocks(), sessionStorage = memoryStorage() }) {
  const start = html.indexOf(IDEMPOTENCY_START);
  const end = html.indexOf(IDEMPOTENCY_END, start);
  assert.ok(start >= 0 && end > start, "missing idempotency source markers");
  const source = html.slice(start + IDEMPOTENCY_START.length, end);
  const field = { value: "" };
  let requestIdCalls = 0;
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    localStorage,
    sessionStorage,
    navigator: locks === null ? {} : { locks },
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
      "globalThis.__api={createInvoicePayloadFingerprint,getOrCreateInvoiceRequestId,readPendingInvoiceRequest_,pendingInvoiceStorageKey_,INVOICE_LEGACY_PENDING_STORAGE_KEY};",
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

test("request id is awaited and its 24-hour marker remains after a positive ACK", () => {
  const prepareIndex = html.indexOf("await getOrCreateInvoiceRequestId(payloadFingerprint)");
  const ackIndex = html.indexOf("await postInvoiceRequest(data)", prepareIndex);
  const resetIndex = html.indexOf("e.target.reset()", ackIndex);
  assert.ok(prepareIndex >= 0 && ackIndex > prepareIndex && resetIndex > ackIndex);
  assert.doesNotMatch(html, /clearInvoiceRequestId/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new Function(source);
});

test("close and reopen reuses the id, changed payload is isolated, and ACK retains the id for 24 hours", async () => {
  const localStorage = memoryStorage();
  const locks = memoryLocks();
  const ids = [
    "web-11111111111111111111111111111111",
    "web-22222222222222222222222222222222",
    "web-33333333333333333333333333333333",
  ];
  const now = 1900000000000;
  const first = loadIdempotency({ localStorage, locks, requestIds: ids });
  const payload = { guest_email: "host@example.com", guest_name: "Test", request_id: "" };
  const fingerprint = await first.api.createInvoicePayloadFingerprint(payload);
  const reordered = await first.api.createInvoicePayloadFingerprint({ ack_nonce: "ignored", request_id: "ignored", guest_name: "Test", guest_email: "host@example.com" });
  assert.equal(fingerprint, reordered, "volatile transport fields and key order must not change the fingerprint");
  const firstId = await first.api.getOrCreateInvoiceRequestId(fingerprint, now);
  assert.equal(firstId, ids[0]);
  assert.equal(first.requestIdCalls, 1);

  const reopened = loadIdempotency({ localStorage, locks, requestIds: ids.slice(1) });
  assert.equal(await reopened.api.getOrCreateInvoiceRequestId(fingerprint, now + 1), firstId);
  assert.equal(reopened.requestIdCalls, 0, "reopened page must not generate another id");

  const changedFingerprint = await reopened.api.createInvoicePayloadFingerprint({ ...payload, guest_name: "Changed" });
  const changedId = await reopened.api.getOrCreateInvoiceRequestId(changedFingerprint, now + 2);
  assert.equal(changedId, ids[1]);
  assert.ok(localStorage.getItem(reopened.api.pendingInvoiceStorageKey_(fingerprint)));
  assert.ok(localStorage.getItem(reopened.api.pendingInvoiceStorageKey_(changedFingerprint)));

  reopened.field.value = ""; // positive ACK resets the form, not the persistent dedupe marker
  const afterAck = loadIdempotency({ localStorage, locks, requestIds: ids.slice(2) });
  assert.equal(await afterAck.api.getOrCreateInvoiceRequestId(changedFingerprint, now + 5), changedId);
  assert.equal(afterAck.requestIdCalls, 0, "positive ACK must not open a duplicate retry window");

  const afterTtl = loadIdempotency({ localStorage, locks, requestIds: ids.slice(2) });
  assert.equal(
    await afterTtl.api.getOrCreateInvoiceRequestId(changedFingerprint, now + 24 * 60 * 60 * 1000 + 3),
    ids[2],
    "an identical legitimate request may receive a new id after the 24-hour window",
  );
});

test("two tabs plus one positive ACK and one lost ACK still reuse exactly one id", async () => {
  const localStorage = memoryStorage();
  const locks = memoryLocks();
  const first = loadIdempotency({
    localStorage, locks, requestIds: ["web-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  });
  const second = loadIdempotency({
    localStorage, locks, requestIds: ["web-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  });
  const fingerprint = await first.api.createInvoicePayloadFingerprint({ guest_name: "Concurrent", request_id: "" });
  const [firstId, secondId] = await Promise.all([
    first.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
    second.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
  ]);
  assert.equal(firstId, secondId);
  assert.equal(first.requestIdCalls + second.requestIdCalls, 1);

  first.field.value = ""; // tab A gets ACK and resets; tab B times out
  const retry = loadIdempotency({
    localStorage, locks, requestIds: ["web-cccccccccccccccccccccccccccccccc"],
  });
  assert.equal(
    await retry.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000001),
    firstId,
    "tab B retry must keep the original id after tab A received ACK",
  );
  assert.equal(retry.requestIdCalls, 0);
});

test("stored pending marker contains no guest PII", async () => {
  const localStorage = memoryStorage();
  const instance = loadIdempotency({
    localStorage,
    requestIds: ["web-cccccccccccccccccccccccccccccccc"],
  });
  const payload = { guest_name: "Sensitive Guest", guest_email: "sensitive@example.com", request_id: "" };
  const fingerprint = await instance.api.createInvoicePayloadFingerprint(payload);
  await instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000);
  const stored = localStorage.getItem(instance.api.pendingInvoiceStorageKey_(fingerprint));
  assert.ok(stored);
  assert.doesNotMatch(stored, /Sensitive Guest|sensitive@example\.com/);
});

test("blocked localStorage fails closed even when sessionStorage is available", async () => {
  const localStorage = memoryStorage({ rejectReads: true, rejectWrites: true });
  const sessionStorage = memoryStorage();
  const instance = loadIdempotency({
    localStorage,
    sessionStorage,
    requestIds: ["web-dddddddddddddddddddddddddddddddd"],
  });
  const fingerprint = await instance.api.createInvoicePayloadFingerprint({ guest_name: "Test", request_id: "" });
  await assert.rejects(
    instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
    /storage blocked|pending-storage-unavailable/,
  );
  assert.equal(instance.field.value, "", "failed persistence must not prepare an id for POST");
  assert.equal(sessionStorage.getItem("booking-invoice-pending-v1:test.example"), null);
  assert.equal(instance.requestIdCalls, 0);
});

test("missing Web Locks support fails before storage or request id generation", async () => {
  const localStorage = memoryStorage();
  const instance = loadIdempotency({
    localStorage,
    locks: null,
    requestIds: ["web-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
  });
  const fingerprint = await instance.api.createInvoicePayloadFingerprint({ guest_name: "Test", request_id: "" });
  await assert.rejects(
    instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
    /pending-lock-unavailable/,
  );
  assert.equal(instance.field.value, "");
  assert.equal(instance.requestIdCalls, 0);
  assert.equal(localStorage.getItem(instance.api.pendingInvoiceStorageKey_(fingerprint)), null);
});

test("expired marker cleanup fails closed if confirmed removal is unavailable", async () => {
  const localStorage = memoryStorage({ rejectRemoves: true });
  const instance = loadIdempotency({
    localStorage,
    requestIds: ["web-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
  });
  const fingerprint = await instance.api.createInvoicePayloadFingerprint({ guest_name: "Expired", request_id: "" });
  localStorage.setItem(instance.api.pendingInvoiceStorageKey_(fingerprint), JSON.stringify({
    version: 2,
    requestId: "web-77777777777777777777777777777777",
    fingerprint,
    expiresAt: 1899999999999,
  }));
  await assert.rejects(
    instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
    /storage blocked/,
  );
  assert.equal(instance.requestIdCalls, 0);
});

+test("expired legacy marker is ignored without deleting the shared v1 key", async () => {
  const localStorage = memoryStorage();
  const instance = loadIdempotency({
    localStorage,
    requestIds: ["web-66666666666666666666666666666666"],
  });
  const fingerprint = await instance.api.createInvoicePayloadFingerprint({ guest_name: "Old legacy", request_id: "" });
  const legacyRaw = JSON.stringify({
    version: 1,
    requestId: "web-55555555555555555555555555555555",
    fingerprint,
    expiresAt: 1899999999999,
  });
  localStorage.setItem(instance.api.INVOICE_LEGACY_PENDING_STORAGE_KEY, legacyRaw);
  assert.equal(
    await instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000),
    "web-66666666666666666666666666666666",
  );
  assert.equal(localStorage.getItem(instance.api.INVOICE_LEGACY_PENDING_STORAGE_KEY), legacyRaw);
});

+test("matching legacy v1 marker copies to v2 without generating a new id or racing its deletion", async () => {
  const localStorage = memoryStorage();
  const instance = loadIdempotency({
    localStorage,
    requestIds: ["web-ffffffffffffffffffffffffffffffff"],
  });
  const fingerprint = await instance.api.createInvoicePayloadFingerprint({ guest_name: "Legacy", request_id: "" });
  const legacyId = "web-99999999999999999999999999999999";
  localStorage.setItem(instance.api.INVOICE_LEGACY_PENDING_STORAGE_KEY, JSON.stringify({
    version: 1,
    requestId: legacyId,
    fingerprint,
    expiresAt: 1900000000000 + 60_000,
  }));
  assert.equal(await instance.api.getOrCreateInvoiceRequestId(fingerprint, 1900000000000), legacyId);
  assert.equal(instance.requestIdCalls, 0);
  assert.ok(localStorage.getItem(instance.api.INVOICE_LEGACY_PENDING_STORAGE_KEY));
  const migrated = JSON.parse(localStorage.getItem(instance.api.pendingInvoiceStorageKey_(fingerprint)));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.requestId, legacyId);
});
