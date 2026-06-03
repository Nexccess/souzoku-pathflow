/**
 * api/diagnose.js
 * Gemini API を用いた相続コンサルティング特化 AI 診断エンドポイント
 *
 * 環境変数:
 *   GEMINI_API_KEY  — Google AI Studio API Key
 *
 * リクエスト (POST):
 *   { answers: string[] }  // 5問の回答
 *
 * レスポンス:
 *   { score, level, summary, issues, nextAction }
 */

export const config = { runtime: 'edge' };

const GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro'];
const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models';

const QUESTIONS = [
  '相続の準備状況（遺言書の有無、財産の把握度）',
  '主な財産の種類と概算総額',
  '法定相続人の人数と関係性（配偶者・子・兄弟など）',
  '事業承継の有無・自社株の状況',
  '最も気になっている課題・懸念事項',
];

const SYSTEM_PROMPT = `あなたは相続コンサルティングの専門AI診断システムです。
ユーザーの5つの回答を分析し、相続における課題と優先アクションを特定してください。

以下のJSON形式のみで回答してください。マークダウンやコードブロックは使用しないこと。

{
  "score": <0〜100の整数>,
  "level": <"A（緊急対応推奨）" | "B（早期対応推奨）" | "C（計画的対応）">,
  "summary": "<現状の課題を2〜3文で要約>",
  "issues": ["<課題1>", "<課題2>", "<課題3>"],
  "nextAction": "<最優先で取り組むべき具体的な1つのアクション>"
}

スコア基準:
- 0〜39: リスクが高い（レベルA）
- 40〜69: 対策が必要（レベルB）
- 70〜100: 基礎はあるが最適化の余地あり（レベルC）`;

async function callGemini(apiKey, model, answers) {
  const userContent = QUESTIONS.map((q, i) => `Q${i + 1}. ${q}\nA: ${answers[i] || '未回答'}`).join('\n\n');

  const body = {
    contents: [
      { role: 'user', parts: [{ text: userContent }] },
    ],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  };

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini ${model} error ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

export default async function handler(req) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY が未設定です。' }), { status: 500, headers });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'リクエストボディの解析に失敗しました。' }), { status: 400, headers });
  }

  const { answers } = body;
  if (!Array.isArray(answers) || answers.length !== 5) {
    return new Response(JSON.stringify({ error: '5問分の回答が必要です。' }), { status: 400, headers });
  }

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const result = await callGemini(apiKey, model, answers);
      return new Response(JSON.stringify({ ...result, model }), { status: 200, headers });
    } catch (e) {
      lastError = e;
    }
  }

  // フォールバック: 全モデル失敗時はルールベースで返却
  const fallback = generateFallback(answers);
  return new Response(
    JSON.stringify({ ...fallback, _fallback: true, _error: lastError?.message }),
    { status: 200, headers }
  );
}

/**
 * Gemini 全失敗時のルールベースフォールバック
 */
function generateFallback(answers) {
  let score = 60;
  const issues = [];

  const [prepStatus, assetType, heirs, business, concern] = answers;

  if (prepStatus && prepStatus.includes('なし')) { score -= 20; issues.push('遺言書が未作成のため、争族リスクが高い状態です'); }
  if (assetType && assetType.includes('不動産')) { score -= 10; issues.push('不動産評価と小規模宅地特例の適用可否を確認する必要があります'); }
  if (business && (business.includes('あり') || business.includes('株'))) { score -= 15; issues.push('自社株評価と後継者への集中移転スキームの検討が急務です'); }

  score = Math.max(10, Math.min(90, score));
  const level = score < 40 ? 'A（緊急対応推奨）' : score < 70 ? 'B（早期対応推奨）' : 'C（計画的対応）';

  if (issues.length === 0) issues.push('現状の把握と将来の相続税試算が必要です');

  return {
    score,
    level,
    summary: `現状分析の結果、相続準備スコアは${score}点です。${concern || '課題'}について専門家との相談を推奨します。`,
    issues,
    nextAction: 'まず財産の全体像を把握し、相続税の試算と遺言書作成の必要性を専門家に確認してください。',
  };
}
