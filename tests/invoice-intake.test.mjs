import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

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

test("request id is retained until positive ACK and inline scripts parse", () => {
  const awaitIndex = html.indexOf("await postInvoiceRequest(data)");
  const clearIndex = html.indexOf("clearInvoiceRequestId()", awaitIndex);
  assert.ok(awaitIndex >= 0 && clearIndex > awaitIndex);
  assert.equal((html.match(/clearInvoiceRequestId\(\)/g) || []).length, 2);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new Function(source);
});
