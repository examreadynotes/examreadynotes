// supabase/functions/gmail-payment-verifier/index.ts
//
// Reads unread Fam payment-confirmation emails from a connected Gmail
// inbox, extracts the transaction details, matches them against pending
// orders in Supabase, and auto-approves matches using the exact same
// workflow as a manual admin approval (status -> verified, in-app
// notification, real push notification). Every email it looks at is
// logged; every processed email is labeled so it's never re-processed.
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_ACCOUNT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Config / secrets
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
const GMAIL_ACCOUNT = Deno.env.get("GMAIL_ACCOUNT") || "examreadynotes@gmail.com";

// Adjust once you've inspected a real Fam email — sender + wording can vary.
const FAM_SENDER_FILTER = "from:fam.app";
const PROCESSED_LABEL = "ERN-Processed";
const AMOUNT_MATCH_TOLERANCE = 1; // rupees, to absorb rounding differences

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ParsedPayment = {
  amount: number | null;
  transactionId: string | null;
  senderName: string | null;
  timestamp: number | null; // ms epoch, from the email's own Date header if parsable
};

type LogOutcome =
  | "approved"
  | "ambiguous"
  | "no_match"
  | "parse_failed"
  | "already_processed"
  | "error";

type LogEntry = {
  gmail_message_id: string;
  parsed_amount: number | null;
  parsed_transaction_id: string | null;
  parsed_sender: string | null;
  matched_order_id: string | null;
  outcome: LogOutcome;
  detail: string | null;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Gmail OAuth2
// ---------------------------------------------------------------------------
async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail OAuth token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("Gmail OAuth token refresh returned no access_token");
  return data.access_token as string;
}

async function gmailFetch(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(GMAIL_ACCOUNT)}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Email parsing
// ---------------------------------------------------------------------------
function decodeBase64Url(data: string): string {
  try {
    return decodeURIComponent(
      atob(data.replace(/-/g, "+").replace(/_/g, "/"))
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
  } catch {
    return atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  }
}

function extractBodyText(payload: any): string {
  if (payload?.body?.data) return decodeBase64Url(payload.body.data);
  if (payload?.parts) {
    // Prefer text/plain, fall back to any nested part (handles multipart/alternative + attachments).
    const plain = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }
  return "";
}

function getHeader(payload: any, name: string): string | null {
  const h = (payload?.headers || []).find((x: any) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// PLACEHOLDER PATTERNS — tune these against a real Fam payment email before
// relying on this in production. The function fails safe (skips instead of
// guessing) whenever a field can't be confidently extracted.
function parsePaymentEmail(payload: any): ParsedPayment {
  const bodyText = extractBodyText(payload);
  const dateHeader = getHeader(payload, "Date");
  const fromHeader = getHeader(payload, "From") || "";

  const amountMatch = bodyText.match(/(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : null;

  const txnMatch = bodyText.match(/(?:UPI\s?Ref|Reference|UTR|Txn\s?ID|Transaction\s?ID)[:\s#]*([A-Za-z0-9]{6,25})/i);
  const transactionId = txnMatch ? txnMatch[1] : null;

  const senderMatch =
    bodyText.match(/(?:from|by|paid by)\s+([A-Za-z][A-Za-z .]{2,40})/i) ||
    fromHeader.match(/^"?([^"<]{2,60})"?\s*</);
  const senderName = senderMatch ? senderMatch[1].trim() : null;

  const timestamp = dateHeader ? Date.parse(dateHeader) : null;

  return { amount, transactionId, senderName, timestamp: Number.isFinite(timestamp) ? timestamp : null };
}

// ---------------------------------------------------------------------------
// Logging + labeling
// ---------------------------------------------------------------------------
let _processedLabelId: string | null = null;

async function ensureProcessedLabel(token: string): Promise<string | null> {
  if (_processedLabelId) return _processedLabelId;
  try {
    const labels = await gmailFetch("/labels", token);
    let label = (labels.labels || []).find((l: any) => l.name === PROCESSED_LABEL);
    if (!label) {
      label = await gmailFetch("/labels", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: PROCESSED_LABEL,
          labelListVisibility: "labelHide",
          messageListVisibility: "hide",
        }),
      });
    }
    _processedLabelId = label.id;
    return label.id;
  } catch (err) {
    console.error("Could not create/find ERN-Processed label:", err);
    return null;
  }
}

async function markEmailProcessed(messageId: string, token: string) {
  try {
    const labelId = await ensureProcessedLabel(token);
    if (!labelId) return;
    await gmailFetch(`/messages/${messageId}/modify`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ["UNREAD"] }),
    });
  } catch (err) {
    console.error(`Failed to label message ${messageId} as processed:`, err);
  }
}

async function writeLog(entry: LogEntry) {
  console.log(`[gmail-payment-verifier] ${entry.outcome} — message ${entry.gmail_message_id}`, entry);
  try {
    await supabase.from("gmail_verify_log").insert([entry]);
  } catch (err) {
    // A unique-constraint violation here just means we've logged this
    // message before — that's an expected "already processed" case, not
    // a real error, so we don't let it interrupt the run.
    console.warn("gmail_verify_log insert issue (may be a harmless duplicate):", err);
  }
}

// ---------------------------------------------------------------------------
// Order matching + approval (mirrors the admin dashboard's approveVerification())
// ---------------------------------------------------------------------------
async function approveOrder(order: { id: string; buyer_user_id: string; item: string }) {
  await supabase
    .from("orders")
    .update({
      status: "verified", // this alone is what unlocks "My Materials" for the student — the frontend reads this field to grant access
      verified_at: Date.now(),
      verification_note: "Auto-verified via Gmail",
      verified_via: "gmail",
    })
    .eq("id", order.id);

  const notifId = "nt_" + Date.now() + "_" + order.buyer_user_id;
  await supabase.from("notifications").insert([
    {
      id: notifId,
      user_id: order.buyer_user_id,
      title: "🎉 Payment Verified Successfully!",
      message: `Your purchased material "${order.item}" is now available in My Materials. Thank you for choosing Exam Ready Notes.`,
      type: "verified",
      order_id: order.id,
      read: false,
      created_at: Date.now(),
    },
  ]);

  // Uses the existing send-push Edge Function so this rides the same real
  // push-notification pipeline as every other alert in the app.
  await supabase.functions.invoke("send-push", {
    body: {
      target: "user",
      user_id: order.buyer_user_id,
      title: "🎉 Payment Verified Successfully!",
      body: `Your material "${order.item}" is now available.`,
      url: "#",
    },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (_req) => {
  const startedAt = Date.now();
  const summary = {
    scanned: 0,
    approved: 0,
    ambiguous: 0,
    no_match: 0,
    parse_failed: 0,
    already_processed: 0,
    errors: 0,
    details: [] as any[],
  };

  try {
    const token = await getAccessToken();

    // Only unread mail from Fam, not already labeled processed.
    const query = `${FAM_SENDER_FILTER} is:unread -label:${PROCESSED_LABEL}`;
    const list = await gmailFetch(`/messages?q=${encodeURIComponent(query)}`, token);
    const messages: { id: string }[] = list.messages || [];
    summary.scanned = messages.length;

    for (const m of messages) {
      try {
        const full = await gmailFetch(`/messages/${m.id}?format=full`, token);

        // Duplicate guard: if we've already logged this exact message ID
        // (e.g. a previous run got interrupted after processing but
        // before labeling), skip it instead of double-approving anything.
        const { data: existingLog } = await supabase
          .from("gmail_verify_log")
          .select("id, outcome")
          .eq("gmail_message_id", m.id)
          .maybeSingle();

        if (existingLog) {
          await markEmailProcessed(m.id, token);
          summary.already_processed++;
          summary.details.push({ id: m.id, outcome: "already_processed" });
          continue;
        }

        const parsed = parsePaymentEmail(full.payload);

        if (!parsed.amount) {
          await writeLog({
            gmail_message_id: m.id,
            parsed_amount: null,
            parsed_transaction_id: parsed.transactionId,
            parsed_sender: parsed.senderName,
            matched_order_id: null,
            outcome: "parse_failed",
            detail: "Could not extract an amount from the email body",
            created_at: Date.now(),
          });
          await markEmailProcessed(m.id, token);
          summary.parse_failed++;
          summary.details.push({ id: m.id, outcome: "parse_failed" });
          continue;
        }

        const { data: candidates, error: queryErr } = await supabase
          .from("orders")
          .select("id, amount, buyer_user_id, item")
          .eq("status", "pending")
          .gte("amount", parsed.amount - AMOUNT_MATCH_TOLERANCE)
          .lte("amount", parsed.amount + AMOUNT_MATCH_TOLERANCE);

        if (queryErr) throw queryErr;

        if (!candidates || candidates.length === 0) {
          await writeLog({
            gmail_message_id: m.id,
            parsed_amount: parsed.amount,
            parsed_transaction_id: parsed.transactionId,
            parsed_sender: parsed.senderName,
            matched_order_id: null,
            outcome: "no_match",
            detail: "No pending order found matching this amount",
            created_at: Date.now(),
          });
          await markEmailProcessed(m.id, token);
          summary.no_match++;
          summary.details.push({ id: m.id, outcome: "no_match", amount: parsed.amount });
          continue;
        }

        if (candidates.length > 1) {
          // Ambiguous — never guess which order this belongs to. Leave
          // every candidate pending for manual review in the admin panel.
          await writeLog({
            gmail_message_id: m.id,
            parsed_amount: parsed.amount,
            parsed_transaction_id: parsed.transactionId,
            parsed_sender: parsed.senderName,
            matched_order_id: null,
            outcome: "ambiguous",
            detail: `${candidates.length} pending orders match this amount — needs manual review`,
            created_at: Date.now(),
          });
          await markEmailProcessed(m.id, token);
          summary.ambiguous++;
          summary.details.push({ id: m.id, outcome: "ambiguous", amount: parsed.amount, candidateCount: candidates.length });
          continue;
        }

        const order = candidates[0];
        await approveOrder(order);

        await writeLog({
          gmail_message_id: m.id,
          parsed_amount: parsed.amount,
          parsed_transaction_id: parsed.transactionId,
          parsed_sender: parsed.senderName,
          matched_order_id: order.id,
          outcome: "approved",
          detail: `Auto-approved order ${order.id} for ₹${parsed.amount}`,
          created_at: Date.now(),
        });
        await markEmailProcessed(m.id, token);
        summary.approved++;
        summary.details.push({ id: m.id, outcome: "approved", orderId: order.id, amount: parsed.amount });
      } catch (perMessageErr) {
        console.error(`Error processing message ${m.id}:`, perMessageErr);
        await writeLog({
          gmail_message_id: m.id,
          parsed_amount: null,
          parsed_transaction_id: null,
          parsed_sender: null,
          matched_order_id: null,
          outcome: "error",
          detail: String(perMessageErr),
          created_at: Date.now(),
        }).catch(() => {});
        summary.errors++;
        summary.details.push({ id: m.id, outcome: "error", detail: String(perMessageErr) });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, ran_in_ms: Date.now() - startedAt, ...summary }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("gmail-payment-verifier fatal error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err), ran_in_ms: Date.now() - startedAt, ...summary }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
