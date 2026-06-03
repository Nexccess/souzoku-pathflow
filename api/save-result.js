/**
 * api/save-result.js
 * 予約確定時の統合処理 Edge Function
 *
 * 処理内容:
 *   1. Google Spreadsheet（AI診断結果シート）への11列書込
 *   2. Google Calendar への仮予約登録
 *   3. Gmail App Password を用いたオーナー通知メール送信
 *
 * 環境変数:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — サービスアカウント JSON 文字列
 *   GMAIL_USER                   — 送信元 Gmail アドレス
 *   GMAIL_APP_PASSWORD           — Gmail アプリパスワード（16桁）
 *   SPREADSHEET_ID               — スプレッドシートID（オプション。未設定時は定数使用）
 *   CALENDAR_ID                  — カレンダーID（オプション）
 *   NOTIFY_EMAIL                 — 通知先メール（オプション）
 *
 * リクエスト (POST):
 *   {
 *     name, email, phone?,
 *     date, time,
 *     score, level, summary, issues, nextAction,
 *     answers: string[]
 *   }
 */

export const config = { runtime: 'edge' };

// ─── 定数 ───────────────────────────────────────────────
const SPREADSHEET_ID  = '1KLQn2ZLHUTjzzUo_xrNCoGSYJkDRE1roSMIILPelFw4';
const SHEET_NAME      = 'AI診断結果';
const CALENDAR_ID     = 'info.nexccess@gmail.com';
const NOTIFY_EMAIL    = 'info.nexccess@gmail.com';
const LP_ID           = 'souzoku-v1';

// ─── JWT / Google Auth ────────────────────────────────────
async function getGoogleAccessToken(sa) {
  const now  = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  // Base64url エンコード
  const enc = (v) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header  = enc({ alg: 'RS256', typ: 'JWT' });
  const body    = enc(payload);
  const sigInput = `${header}.${body}`;

  // RSA-SHA256 署名
  const pemKey = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  // Uint8Array.from().buffer はdetachedになる場合があるため、
  // slice()でコピーした新規ArrayBufferを渡す
  const keyBuf = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuf.buffer.slice(0),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const sigB64 = btoa(Array.from(new Uint8Array(sigBuf)).map(b => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${sigInput}.${sigB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google OAuth失敗: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ─── Spreadsheet 書込 ─────────────────────────────────────
async function writeToSheet(token, data) {
  const ssId = process.env.SPREADSHEET_ID || SPREADSHEET_ID;
  const now   = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  // 11列標準構成
  const row = [
    now,                              // A: 登録日時
    LP_ID,                            // B: LP識別ID
    data.name       || '',            // C: 氏名
    data.email      || '',            // D: メールアドレス
    data.phone      || '',            // E: 電話番号
    data.date       || '',            // F: 希望日
    data.time       || '',            // G: 希望時間帯
    String(data.score ?? ''),         // H: スコア
    data.level      || '',            // I: レベル
    data.summary    || '',            // J: 診断サマリー
    data.nextAction || '',            // K: ネクストアクション
  ];

  // Sheets v4 append: /values/{range}:append
  // range は「シート名!A:K」全体をencodeする必要がある
  const range = encodeURIComponent(`${SHEET_NAME}!A:K`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Sheets書込失敗 ${res.status}: ${err.slice(0, 200)}`);
  }
}

// ─── Calendar 仮予約登録 ──────────────────────────────────
async function createCalendarEvent(token, data) {
  const calId = process.env.CALENDAR_ID || CALENDAR_ID;

  // 日付・時間の組み立て（例: 2026-06-15, 10:00〜11:00 と仮定）
  const [year, month, day] = (data.date || '').split('-');
  const startHour = parseInt((data.time || '10:00').split(':')[0], 10);
  const tz = 'Asia/Tokyo';

  const start = new Date(Date.UTC(
    parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10),
    startHour - 9  // JST → UTC
  ));
  const end = new Date(start.getTime() + 60 * 60 * 1000); // 1時間

  const event = {
    summary: `【仮予約】相続無料相談 — ${data.name || '未設定'} 様`,
    description: [
      `スコア: ${data.score}点 / レベル: ${data.level}`,
      `診断サマリー: ${data.summary}`,
      `ネクストアクション: ${data.nextAction}`,
      `メール: ${data.email}`,
      `電話: ${data.phone || '未記入'}`,
    ].join('\n'),
    start: { dateTime: start.toISOString(), timeZone: tz },
    end:   { dateTime: end.toISOString(),   timeZone: tz },
    attendees: data.email ? [{ email: data.email }] : [],
    status: 'tentative',
    colorId: '5', // バナナ色（仮予約を視覚的に識別）
  };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?sendUpdates=externalOnly`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Calendar登録失敗 ${res.status}: ${err.slice(0, 200)}`);
  }
  const result = await res.json();
  return result.id;
}

// ─── Gmail 通知メール送信（SMTP over fetch — Gmail API） ──────
async function sendNotificationEmail(token, data) {
  const to      = process.env.NOTIFY_EMAIL || NOTIFY_EMAIL;
  const subject = `【Path-Flow 相続診断】新規予約 — ${data.name || '未設定'} 様（スコア${data.score}点）`;
  const body    = `
Path-Flow 相続診断 に新規予約が入りました。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▼ 予約者情報
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
氏名:     ${data.name || '未記入'}
メール:   ${data.email || '未記入'}
電話:     ${data.phone || '未記入'}
希望日:   ${data.date || '未記入'}
希望時間: ${data.time || '未記入'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▼ AI診断結果
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
スコア:   ${data.score}点
レベル:   ${data.level}
サマリー: ${data.summary}
課題:
${(data.issues || []).map((v, i) => `  ${i + 1}. ${v}`).join('\n')}
ネクストアクション: ${data.nextAction}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Google カレンダーに仮予約を登録しました。
LP ID: ${LP_ID}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

合同会社 Nexccess — Path-Flow AI 診断システム
`.trim();

  // Gmail API（send）用 RFC 2822 メッセージ作成
  const mime = [
    `To: ${to}`,
    `From: Path-Flow 相続診断 <${process.env.GMAIL_USER || NOTIFY_EMAIL}>`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(unescape(encodeURIComponent(body))),
  ].join('\r\n');

  const encoded = btoa(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    // メール送信失敗はログのみ（予約処理は継続）
    console.error(`Gmail送信失敗 ${res.status}: ${err.slice(0, 200)}`);
  }
}

// ─── Handler ─────────────────────────────────────────────
export default async function handler(req) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST')   return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return new Response(JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。' }), { status: 500, headers });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'リクエストボディの解析に失敗しました。' }), { status: 400, headers });
  }

  const required = ['name', 'email', 'date', 'time', 'score', 'level'];
  const missing  = required.filter(k => !body[k] && body[k] !== 0);
  if (missing.length) {
    return new Response(JSON.stringify({ error: `必須項目が不足しています: ${missing.join(', ')}` }), { status: 400, headers });
  }

  let sa;
  try {
    sa = JSON.parse(saJson);
  } catch {
    return new Response(JSON.stringify({ error: 'サービスアカウントJSONが不正です。' }), { status: 500, headers });
  }

  const results = { sheet: false, calendar: false, email: false };
  const errors  = [];

  try {
    const token = await getGoogleAccessToken(sa);

    // 1. スプレッドシート書込
    try {
      await writeToSheet(token, body);
      results.sheet = true;
    } catch (e) {
      errors.push(`Sheet: ${e.message}`);
    }

    // 2. カレンダー仮予約
    let eventId = null;
    try {
      eventId = await createCalendarEvent(token, body);
      results.calendar = true;
    } catch (e) {
      errors.push(`Calendar: ${e.message}`);
    }

    // 3. 通知メール
    try {
      await sendNotificationEmail(token, body);
      results.email = true;
    } catch (e) {
      errors.push(`Email: ${e.message}`);
    }

    return new Response(
      JSON.stringify({ success: true, results, eventId, errors: errors.length ? errors : null }),
      { status: 200, headers }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers }
    );
  }
}
