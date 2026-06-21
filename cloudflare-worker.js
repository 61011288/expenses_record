// Cloudflare Worker：记账 app 的 DeepSeek 代理
// 作用：前端把一句话开支描述发给这个 Worker，Worker 用藏在
// 环境变量 DEEPSEEK_KEY 里的 key 去调 DeepSeek，解析出结构化账目并返回。
// key 只存在 Cloudflare，不会出现在公开的前端代码里。
//
// 部署后需要设置：
//   1) 环境变量（Secret）DEEPSEEK_KEY = 你的 DeepSeek API key
//   2) 下面 ALLOWED 改成你部署网页的真实地址（例如 GitHub Pages 网址）

const ALLOWED = 'https://your-username.github.io';

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

    const systemPrompt =
      '你是一个记账助手。用户会用一句话描述一笔收入或支出，你需要尽量提取出结构化信息。' +
      '今天的日期是 ' + todayStr + '（如果用户没提日期，就用今天）。' +
      '支出类别只能从这些里选：' + categories.expense.join('、') + '。' +
      '收入类别只能从这些里选：' + categories.income.join('、') + '。' +
      '只输出 JSON，不要任何多余文字，格式严格为：' +
      '{"reply":"一句简短的中文确认或追问","expense":null 或 {"type":"expense或income","amount":数字,"category":"类别名","date":"YYYY-MM-DD","note":"简短备注，可为空字符串"}}。' +
      '如果用户的话里没有明确金额，无法确定具体数字，expense 必须为 null，并在 reply 里追问金额。' +
      '如果信息足够，expense 必须填好，reply 给一句简短确认，比如"好的，已为你整理好"。';

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
          max_tokens: 300,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      const data = await r.json();
      const txt = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();

      let reply = '抱歉，我没听懂，能再说一次吗？';
      let expense = null;
      try {
        const j = JSON.parse(txt.replace(/```json|```/g, '').trim());
        if (j.reply) reply = String(j.reply).slice(0, 200);
        if (j.expense && typeof j.expense === 'object') {
          expense = {
            type: j.expense.type === 'income' ? 'income' : 'expense',
            amount: parseFloat(j.expense.amount) || 0,
            category: String(j.expense.category || '').slice(0, 20),
            date: j.expense.date,
            note: String(j.expense.note || '').slice(0, 60),
          };
        }
      } catch {
        // model didn't return valid JSON; fall back to raw text as the reply
        if (txt) reply = txt.slice(0, 200);
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
