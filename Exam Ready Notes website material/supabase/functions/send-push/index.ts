import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'mailto:support@examreadynotes.com',
  Deno.env.get('BEG8IVqWgvtV3NMVXF5XaIuEFskyMxHGxpPnaUbnDHnQ5DP11dQ2FfzVtOUqyWdbBSmG35dJ24j52YlKXSi2TXM')!,
  Deno.env.get('BgOe7bIGiLLDadbztFSem0PwilmOdRZi0cN8QZF3P6g')!,
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const { target, user_id, title, body, url, icon } = await req.json();

    let query = supabaseAdmin.from('push_subscriptions').select('*');
    if (target === 'admins') query = query.eq('is_admin_device', true);
    else if (target === 'user' && user_id) query = query.eq('user_id', user_id);
    else {
      return new Response(JSON.stringify({ error: 'target must be "admins" or "user" (with user_id)' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const { data: subs, error } = await query;
    if (error) throw error;

    const payload = JSON.stringify({ title, body, url: url || '/', icon: icon || '/logo.png' });
    let sent = 0, failed = 0;

    await Promise.all((subs || []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        sent++;
      } catch (err: any) {
        failed++;
        // 404/410 = the browser unsubscribed or the subscription expired —
        // clean up so we stop trying to send to a dead endpoint.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        }
      }
    }));

    return new Response(JSON.stringify({ success: true, sent, failed, total: (subs || []).length }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('send-push failed:', err);
    return new Response(JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
});