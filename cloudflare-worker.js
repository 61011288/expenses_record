// Cloudflare Worker：记账 app 的 DeepSeek 代理
// 作用：前端把一句话开支描述发给这个 Worker，Worker 用藏在
// 环境变量 DEEPSEEK_KEY 里的 key 去调 DeepSeek，解析出结构化账目并返回。
// key 只存在 Cloudflare，不会出现在公开的前端代码里。
//
// 部署后需要设置：
//   1) 环境变量（Secret）DEEPSEEK_KEY = 你的 DeepSeek API key
//   2) 下面 ALLOWED 改成你部署网页的真实地址（例如 GitHub Pages 网址）

const ALLOWED = 'https://61011288.github.io';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, cors);
    }

    const origin = request.headers.get('Origin');
    if (origin && origin !== ALLOWED) {
      return json({ error: 'forbidden origin' }, 403, cors);
    }

    let body;
    try { body = await request.json(); } catch { body = {}; }

    // list available models (for the app's "拉取模型" button)
    if (body.action === 'models') {
      try {
        const r = await fetch('https://api.deepseek.com/models', {
          headers: { 'Authorization': 'Bearer ' + env.DEEPSEEK_KEY, 'Accept': 'application/json' },
        });
        const d = await r.json();
        const models = (d.data || []).map((m) => m.id);
        return json({ models }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 502, cors);
      }
    }

    if (body.action !== 'chat') return json({ error: 'unknown action' }, 400, cors);

    const messages = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
    if (!messages.length) return json({ error: 'no messages' }, 400, cors);

    const model = body.model || 'deepseek-chat';
    const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
    const categories = body.categories && body.categories.expense && body.categories.income
      ? body.categories
      : { expense: ['餐饮', '交通', '娱乐', '购物', '居住', '医疗', '其他'], income: ['工资', '其他'] };

    // NOTE: ask the model to reply with ASCII only (numbers/indices). DeepSeek's
    // Chinese response bytes get corrupted in transit to this Worker, but digits
    // survive — so we map indices back to the (locally-known-good) Chinese
    // category names ourselves, and build the Chinese reply text here too.
    const expenseCats = categories.expense;
    const incomeCats = categories.income;
    const systemPrompt =
      'You extract a bookkeeping entry from a Chinese sentence about spending or income. ' +
      'Today is ' + todayStr + ' (use it if the user gives no date). ' +
      'Output ONLY JSON, ASCII only, no Chinese characters, no other text: ' +
      '{"status":"ok" or "ask","type":1 or 2,"cat":N,"amount":number or 0,"date":"YYYY-MM-DD"}. ' +
      'type: 1=expense(支出) 2=income(收入). ' +
      'cat: 1-based index into the expense category list (if type=1) or income category list (if type=2). ' +
      'Expense categories by index: ' + expenseCats.map((c, i) => (i + 1) + '=' + c).join(' ') + '. ' +
      'Income categories by index: ' + incomeCats.map((c, i) => (i + 1) + '=' + c).join(' ') + '. ' +
      'If the amount is not clearly stated, set status to "ask" and amount to 0. Otherwise set status to "ok".';

    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.DEEPSEEK_KEY,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 100,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      const data = await r.json();
      const txt = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();

      const lastUserNote = String((messages[messages.length - 1] || {}).content || '').slice(0, 60);
      let reply = '抱歉，我没听懂，能再说一次吗？';
      let expense = null;
      try {
        const j = JSON.parse(txt.replace(/```json|```/g, '').trim());
        const type = j.type === 2 ? 'income' : 'expense';
        const cats = type === 'income' ? incomeCats : expenseCats;
        const catName = cats[(parseInt(j.cat, 10) || 1) - 1] || cats[cats.length - 1];
        const amount = parseFloat(j.amount) || 0;

        if (j.status === 'ok' && amount > 0) {
          expense = { type, amount, category: catName, date: j.date, note: lastUserNote };
          reply = '好的，' + catName + ' ' + amount + ' 元，已为你整理好';
        } else {
          reply = '金额好像没说清楚，能告诉我具体多少钱吗？';
        }
      } catch {
        // model didn't return valid JSON — ask the user to rephrase rather than
        // risk showing corrupted/garbled text
        reply = '没太听懂，能换个说法再说一次吗？';
      }

      return json({ reply, expense }, 200, cors);
    } catch (e) {
      return json({ error: String(e) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
