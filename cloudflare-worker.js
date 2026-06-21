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

    // require a browser-supplied Origin matching ALLOWED — a missing Origin
    // (e.g. a direct curl/script call bypassing the page) is rejected too,
    // otherwise CORS only blocks browsers and does nothing against non-browser callers
    const origin = request.headers.get('Origin');
    if (origin !== ALLOWED) {
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
      'You extract bookkeeping entries from a Chinese or English sentence about spending and/or income. ' +
      'The sentence may describe ONE or SEVERAL separate transactions (e.g. several items separated by commas). ' +
      'Extract one entry per distinct amount mentioned. ' +
      'Today is ' + todayStr + ' (use it if the user gives no date). ' +
      'Output ONLY JSON, ASCII only, no Chinese characters, no other text: ' +
      '{"entries":[{"type":1 or 2,"cat":N,"amount":number,"date":"YYYY-MM-DD"}, ...]}. ' +
      'type: 1=expense(支出) 2=income(收入). ' +
      'cat: 1-based index into the expense category list (if type=1) or income category list (if type=2). ' +
      'Expense categories by index: ' + expenseCats.map((c, i) => (i + 1) + '=' + c).join(' ') + '. ' +
      'Income categories by index: ' + incomeCats.map((c, i) => (i + 1) + '=' + c).join(' ') + '. ' +
      'Only include entries where a clear positive amount is stated. ' +
      'If the message is not describing any transaction with a clear amount (e.g. it is just stating current ' +
      'account balances, asking a question, or otherwise not "I spent/earned X on Y"), entries must be []. ' +
      'Never guess an amount that was not stated.';

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
          max_tokens: 200,
          // some models (e.g. deepseek-v4-pro) default to extended "thinking" and put the
          // real answer in reasoning_content instead of content, often truncated before
          // it ever gets there — turn that off so content always has the JSON we asked for
          thinking: { type: 'disabled' },
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      const data = await r.json();
      if (body.debug) return json({ status: r.status, raw: data }, 200, cors);
      const txt = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();

      const lastUserNote = String((messages[messages.length - 1] || {}).content || '').slice(0, 60);
      let reply = '没太听懂，能换个说法再说一次吗？';
      let expenses = [];
      try {
        const j = JSON.parse(txt.replace(/```json|```/g, '').trim());
        const rawEntries = Array.isArray(j.entries) ? j.entries : [];
        expenses = rawEntries
          .map(e => {
            const type = e.type === 2 ? 'income' : 'expense';
            const cats = type === 'income' ? incomeCats : expenseCats;
            const catName = cats[(parseInt(e.cat, 10) || 1) - 1] || cats[cats.length - 1];
            const amount = parseFloat(e.amount) || 0;
            return { type, amount, category: catName, date: e.date, note: lastUserNote };
          })
          .filter(e => e.amount > 0);

        if (expenses.length === 1) {
          reply = '好的，' + expenses[0].category + ' ' + expenses[0].amount + ' 元，已为你整理好';
        } else if (expenses.length > 1) {
          reply = '好的，整理出 ' + expenses.length + ' 笔：' +
            expenses.map(e => e.category + ' ' + e.amount).join('、') + '，已为你整理好';
        } else {
          reply = '没看出明确的一笔收支。如果是想设置账户余额，去统计页点一下余额数字直接改就行；如果是记账，告诉我具体花了/收了多少钱。';
        }
      } catch {
        // model didn't return valid JSON — ask the user to rephrase rather than
        // risk showing corrupted/garbled text
        reply = '没太听懂，能换个说法再说一次吗？';
      }

      return json({ reply, expenses }, 200, cors);
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
