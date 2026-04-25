#!/usr/bin/env node
/**
 * Webhook Server: Instantly → GHL Campaign-Aware Auto-Tagger
 *
 * When a lead replies to an Instantly campaign:
 * 1. Determines sentiment (positive/negative)
 * 2. Looks up contact in GHL by email
 * 3. Tags contact in GHL with campaign-specific tag (e.g., "life-insurance-truckers-positive-reply")
 * 4. Tags lead in Instantly with matching tag
 *
 * Supports both GHL locations (old + new)
 */

const http = require('http');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const GHL_API_KEY_OLD = process.env.GHL_API_KEY_OLD || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2NhdGlvbl9pZCI6InAzSEV5MHhoMjFiamloS2J6U2xTIiwiY29tcGFueV9pZCI6IjBPRjNtYWE2T0wyZmRkRzEzeFYxIiwidmVyc2lvbiI6MSwiaWF0IjoxNjg0MzY0MDk0NjMyLCJzdWIiOiJUUUpVdVJHWmttU2k3aERKWHRoYiJ9.KNf0jrKjzOM4AjKc8j0FsmXJgkiL9dmEwTENFvB7aNQ';
const GHL_API_KEY_NEW = process.env.GHL_API_KEY_NEW || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2NhdGlvbl9pZCI6InRiaGhaWnJ4UnhRcm9ZNnk3U2ZEIiwidmVyc2lvbiI6MSwiaWF0IjoxNzczMzQzMjkyMTk3LCJzdWIiOiJySXNsNlVBRTVZOHY1TU9nemdEQiJ9.1EFMQGcMrOEcAX2EJLfLrs7Cza0u23R-yX1d-4h_kaY';
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || 'MDVlMGRhOGUtYmUyOC00MDVjLWIxM2QtMTYxZjMwNGVhMWQxOnFLb2Jqc1loQkZnUg==';
const PORT = process.env.PORT || 3000;

const GHL_BASE = 'https://services.leadconnectorhq.com';
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';

const GHL_LOCATIONS = {
  old: {
    id: 'p3HEy0xh21bjihKbzSlS',
    label: 'hkgoldstein@gmail.com',
    api_key: GHL_API_KEY_OLD,
  },
  new: {
    id: 'w8qJi0GroHpw2i4bYGQL',
    label: 'hansmanagers@gmail.com',
    api_key: GHL_API_KEY_NEW,
  }
};

// ── CAMPAIGN TAG MAPPING ───────────────────────────────────────────────────
// Map Instantly campaign names/IDs to GHL tag prefixes.
// When a reply comes in from a campaign, the tag applied will be:
//   "{prefix}-positive-reply" or "{prefix}-negative-reply"
const CAMPAIGN_TAG_MAP = {
  // Instantly campaign name (lowercase) → tag prefix for both GHL and Instantly
  'life insurance for truckers': 'life-insurance-truckers',
  'life insurance truckers': 'life-insurance-truckers',
  'truckers': 'life-insurance-truckers',
  'myga': 'myga-outreach',
  'iul': 'iul-outreach',
  'workshop': 'workshop-invite',
};

// Default tag prefix if campaign doesn't match any mapping
const DEFAULT_TAG_PREFIX = 'email-campaign';

// ── SENTIMENT DETECTION ────────────────────────────────────────────────────
function determineSentiment(data) {
  const sentiment = (data.sentiment || data.reply_type || data.status || '').toLowerCase();
  const replyText = (data.reply_text || data.body || data.text || '').toLowerCase();

  const positiveSignals = [
    'positive', 'interested', 'yes', 'definitely', 'absolutely',
    'count me in', 'let\'s do it', 'tell me more', 'sounds good',
    'i\'m interested', 'send me', 'let\'s talk', 'call me',
    'when can we', 'how do i', 'sign me up', 'i want'
  ];

  if (positiveSignals.some(s => sentiment.includes(s) || replyText.includes(s))) {
    return 'positive';
  }

  return 'negative';
}

// ── RESOLVE CAMPAIGN TAG PREFIX ────────────────────────────────────────────
function getCampaignTagPrefix(data) {
  const campaignName = (data.campaign_name || data.campaign || data.sequence_name || '').toLowerCase().trim();
  const campaignId = data.campaign_id || data.sequence_id || '';

  // Try exact match first
  if (CAMPAIGN_TAG_MAP[campaignName]) {
    return CAMPAIGN_TAG_MAP[campaignName];
  }

  // Try partial match
  for (const [key, prefix] of Object.entries(CAMPAIGN_TAG_MAP)) {
    if (campaignName.includes(key) || key.includes(campaignName)) {
      return prefix;
    }
  }

  // Fall back to slugified campaign name if we have one
  if (campaignName) {
    return campaignName.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  return DEFAULT_TAG_PREFIX;
}

// ── GHL: LOOKUP CONTACT BY EMAIL ───────────────────────────────────────────
async function lookupGHLContact(locationKey, email) {
  const loc = GHL_LOCATIONS[locationKey];
  if (!loc.api_key) return null;

  try {
    const url = `${GHL_BASE}/contacts/search/duplicate?locationId=${loc.id}&email=${encodeURIComponent(email)}`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${loc.api_key}`,
        'Version': '2021-07-28',
      }
    });
    if (r.ok) {
      const data = await r.json();
      const contact = data.contact;
      if (contact && contact.id) return contact.id;
    }
  } catch (e) {
    console.log(`[${ts()}] GHL lookup error (${locationKey}): ${e.message}`);
  }
  return null;
}

// ── GHL: TAG CONTACT ───────────────────────────────────────────────────────
async function tagGHLContact(locationKey, contactId, tags) {
  const loc = GHL_LOCATIONS[locationKey];
  if (!loc.api_key) return { success: false, error: 'no_key', location: locationKey };

  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${loc.api_key}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags })
    });
    if (r.ok) {
      console.log(`[${ts()}] GHL (${locationKey}) tagged ${contactId}: ${tags.join(', ')}`);
      return { success: true, location: locationKey };
    } else {
      const err = await r.text();
      console.log(`[${ts()}] GHL (${locationKey}) tag failed: ${r.status} ${err.slice(0, 150)}`);
      return { success: false, error: err, location: locationKey };
    }
  } catch (e) {
    return { success: false, error: e.message, location: locationKey };
  }
}

// ── GHL: ADD NOTE ──────────────────────────────────────────────────────────
async function addGHLNote(locationKey, contactId, noteBody) {
  const loc = GHL_LOCATIONS[locationKey];
  if (!loc.api_key) return;

  try {
    await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${loc.api_key}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: noteBody })
    });
  } catch (e) { /* best effort */ }
}

// ── INSTANTLY: TAG LEAD ────────────────────────────────────────────────────
// Flow: 1) find or create the custom tag by label, 2) find lead by email,
//       3) assign tag to lead via toggle-resource endpoint.
async function tagInstantlyLead(email, campaignId, tagLabel) {
  try {
    // Step 1: Find or create the custom tag
    const tagId = await getOrCreateInstantlyTag(tagLabel);
    if (!tagId) {
      console.log(`[${ts()}] Instantly: could not get/create tag "${tagLabel}"`);
      return { success: false, error: 'tag_creation_failed' };
    }

    // Step 2: Find lead by email
    const leadRes = await fetch(`${INSTANTLY_BASE}/leads/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, limit: 1 })
    });

    if (!leadRes.ok) {
      console.log(`[${ts()}] Instantly: lead search failed for ${email}: ${leadRes.status}`);
      return { success: false, error: 'lead_not_found' };
    }

    const leadData = await leadRes.json();
    const leads = leadData.items || [];
    if (leads.length === 0) {
      console.log(`[${ts()}] Instantly: no lead found for ${email}`);
      return { success: false, error: 'lead_not_found' };
    }

    const leadId = leads[0].id;

    // Step 3: Assign tag to lead
    const toggleRes = await fetch(`${INSTANTLY_BASE}/custom-tags/toggle-resource`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag_ids: [tagId],
        resource_ids: [leadId],
        resource_type: 1,  // 1 = lead
        assign: true,
      })
    });

    if (toggleRes.ok) {
      console.log(`[${ts()}] Instantly tagged ${email} (lead ${leadId}) with "${tagLabel}"`);
      return { success: true, lead_id: leadId, tag_id: tagId };
    }

    const errText = await toggleRes.text();
    console.log(`[${ts()}] Instantly toggle-resource failed: ${toggleRes.status} ${errText.slice(0, 150)}`);
    return { success: false, error: errText };
  } catch (e) {
    console.log(`[${ts()}] Instantly tag error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// Cache of tag label → tag ID to avoid re-creating
const tagCache = {};

async function getOrCreateInstantlyTag(label) {
  if (tagCache[label]) return tagCache[label];

  try {
    // List existing tags and check for match
    const listRes = await fetch(`${INSTANTLY_BASE}/custom-tags?limit=100`, {
      headers: { 'Authorization': `Bearer ${INSTANTLY_API_KEY}` }
    });
    if (listRes.ok) {
      const data = await listRes.json();
      const existing = (data.items || []).find(t => t.label === label);
      if (existing) {
        tagCache[label] = existing.id;
        return existing.id;
      }
    }

    // Create new tag
    const createRes = await fetch(`${INSTANTLY_BASE}/custom-tags`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label })
    });

    if (createRes.ok) {
      const created = await createRes.json();
      tagCache[label] = created.id;
      console.log(`[${ts()}] Instantly: created tag "${label}" (${created.id})`);
      return created.id;
    }
  } catch (e) {
    console.log(`[${ts()}] Instantly tag lookup/create error: ${e.message}`);
  }
  return null;
}

// ── MAIN WEBHOOK HANDLER ──────────────────────────────────────────────────
async function handleReplyWebhook(data) {
  const email = data.email || data.lead_email || data.to_email || '';
  const sentiment = determineSentiment(data);
  const tagPrefix = getCampaignTagPrefix(data);
  const replyText = data.reply_text || data.body || data.text || '';

  const sentimentTag = `${tagPrefix}-${sentiment}-reply`;
  const campaignTag = tagPrefix;

  console.log(`[${ts()}] Reply from: ${email} | Campaign: ${tagPrefix} | Sentiment: ${sentiment}`);
  console.log(`[${ts()}] Tags to apply: ${sentimentTag}, ${campaignTag}`);

  const results = { email, sentiment, tags: [sentimentTag, campaignTag], ghl: {}, instantly: {} };

  if (!email) {
    console.log(`[${ts()}] No email in payload — skipping`);
    return { success: false, error: 'no_email', ...results };
  }

  // 1. Tag in GHL (both locations)
  for (const locKey of ['old', 'new']) {
    const contactId = await lookupGHLContact(locKey, email);
    if (contactId) {
      const tagResult = await tagGHLContact(locKey, contactId, [sentimentTag, campaignTag]);
      results.ghl[locKey] = tagResult;

      // Add note with reply preview
      const noteBody = `**Email Reply (${sentiment})**\nCampaign: ${tagPrefix}\nReply: ${replyText.slice(0, 300)}`;
      await addGHLNote(locKey, contactId, noteBody);
    } else {
      console.log(`[${ts()}] GHL (${locKey}): no contact found for ${email}`);
      results.ghl[locKey] = { success: false, error: 'not_found' };
    }
  }

  // 2. Tag in Instantly
  const campaignId = data.campaign_id || data.sequence_id || '';
  results.instantly = await tagInstantlyLead(email, campaignId, sentimentTag);

  return { success: true, ...results };
}

// ── TIMESTAMP HELPER ───────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }

// ── HTTP SERVER ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── Main webhook endpoint (handles all campaigns) ──────────────────────
  if (req.url === '/webhook/instantly' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log(`\n[${ts()}] WEBHOOK received:`, JSON.stringify(data, null, 2));
        const result = await handleReplyWebhook(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error(`[${ts()}] Webhook error:`, e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── Legacy endpoints (still work, route to main handler) ───────────────
  if ((req.url === '/webhook/instantly/positive' || req.url === '/webhook/instantly/neutral') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        // Force sentiment from URL path
        if (req.url.includes('positive')) data.sentiment = 'positive';
        if (req.url.includes('neutral')) data.sentiment = 'negative';
        const result = await handleReplyWebhook(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── Status ─────────────────────────────────────────────────────────────
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      version: '3.0 — Campaign-Aware Tagger',
      port: PORT,
      endpoints: {
        main_webhook: 'POST /webhook/instantly',
        legacy_positive: 'POST /webhook/instantly/positive',
        legacy_neutral: 'POST /webhook/instantly/neutral',
      },
      campaign_tags: CAMPAIGN_TAG_MAP,
      ghl_locations: Object.fromEntries(
        Object.entries(GHL_LOCATIONS).map(([k, v]) => [k, { id: v.id, label: v.label, has_key: !!v.api_key }])
      ),
      instantly: { has_key: !!INSTANTLY_API_KEY },
    }, null, 2));
    return;
  }

  // ── Health ─────────────────────────────────────────────────────────────
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ── Root ───────────────────────────────────────────────────────────────
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Instantly → GHL Tagger v3</title>
<style>body{font-family:system-ui;margin:2rem;background:#f5f5f5}
.c{max-width:700px;margin:0 auto;background:#fff;padding:2rem;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{margin-top:0}.ep{background:#f9f9f9;padding:.75rem;margin:.5rem 0;border-left:4px solid #007bff;font-family:monospace}
.ok{color:#155724;background:#d4edda;padding:1rem;border-radius:4px;margin:1rem 0}</style></head>
<body><div class="c">
<h1>Instantly → GHL Tagger v3</h1>
<div class="ok">Running — Campaign-aware tagging active</div>
<h3>Webhook</h3>
<div class="ep">POST /webhook/instantly</div>
<h3>Campaign → Tag Mapping</h3>
<ul>${Object.entries(CAMPAIGN_TAG_MAP).map(([k,v]) => `<li><b>${k}</b> → ${v}-{positive|negative}-reply</li>`).join('')}</ul>
<h3>GHL Locations</h3>
<ul>${Object.entries(GHL_LOCATIONS).map(([k,v]) => `<li>${k}: ${v.label} (${v.api_key ? 'ready' : 'no key'})</li>`).join('')}</ul>
</div></body></html>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`\n[${ts()}] Instantly → GHL Tagger v3 running on port ${PORT}`);
  console.log(`  Webhook: POST /webhook/instantly`);
  console.log(`  Campaigns: ${Object.keys(CAMPAIGN_TAG_MAP).join(', ')}`);
  console.log(`  GHL old: ${GHL_LOCATIONS.old.label} (${GHL_LOCATIONS.old.api_key ? 'ready' : 'NO KEY'})`);
  console.log(`  GHL new: ${GHL_LOCATIONS.new.label} (${GHL_LOCATIONS.new.api_key ? 'ready' : 'NO KEY'})`);
  console.log(`  Instantly API: ${INSTANTLY_API_KEY ? 'ready' : 'NO KEY'}\n`);
});
