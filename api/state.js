// Stores task progress in data/state.json on the "data" branch of the GitHub repo.
// Env vars (Vercel): GITHUB_TOKEN, APP_PASSWORD, optional GITHUB_REPO, DATA_BRANCH
const REPO = process.env.GITHUB_REPO || 'malikmehmetoglu-spec/ACU';
const BRANCH = process.env.DATA_BRANCH || 'data';
const PATH = 'data/state.json';
const API = `https://api.github.com/repos/${REPO}/contents/${PATH}`;

function gh(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'acu-tasks',
      ...(opts.headers || {}),
    },
  });
}

async function read() {
  const r = await gh(`${API}?ref=${BRANCH}&t=${Date.now()}`);
  if (r.status === 404) return { state: { items: {}, log: [] }, sha: null };
  if (!r.ok) throw new Error('GitHub read ' + r.status);
  const j = await r.json();
  const txt = Buffer.from(j.content, 'base64').toString('utf8');
  return { state: JSON.parse(txt || '{}'), sha: j.sha };
}

async function write(state, sha, msg) {
  const body = {
    message: msg,
    content: Buffer.from(JSON.stringify(state, null, 1)).toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  return gh(API, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

const ROLES = {
  supervisor: { env: 'PASS_SUPERVISOR', name: 'المشرف العام' },
  manager: { env: 'PASS_MANAGER', name: 'المدير الإعلامي' },
  crew: { env: 'PASS_CREW', name: 'المصور والمونتير' },
};
const REVIEW = { reel: 2, promo: 3 };
function roleOf(pass) {
  if (!pass) return null;
  for (const [k, r] of Object.entries(ROLES)) if (process.env[r.env] && process.env[r.env] === pass) return k;
  return null;
}
// returns error string or null
function check(role, group, old, patch) {
  const keys = Object.keys(patch);
  const rv = REVIEW[group];
  const changed = [];
  if (patch.stages) {
    const a = old.stages || [], b = patch.stages;
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (!!a[i] !== !!b[i]) changed.push(i);
  }
  if (role === 'supervisor') {
    if (keys.some(k => !['stages', 'reviewNote'].includes(k))) return 'FORBIDDEN';
    if (changed.some(i => i !== rv)) return 'FORBIDDEN';
    return null;
  }
  if (keys.includes('reviewNote')) return 'FORBIDDEN';
  if (rv !== undefined && changed.includes(rv)) return 'FORBIDDEN';
  if (role === 'crew' && keys.some(k => !['stages', 'link', 'notes'].includes(k))) return 'FORBIDDEN';
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: 'NO_TOKEN' });
  const role = roleOf(req.headers['x-pass']);
  if (!role) return res.status(401).json({ error: 'AUTH' });
  const who = ROLES[role].name;
  try {
    if (req.method === 'GET') {
      const { state } = await read();
      return res.status(200).json({ ...state, role, who });
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const { id, group, patch, label } = body || {};
      if (!id || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'BAD' });
      for (let i = 0; i < 5; i++) {
        const { state, sha } = await read();
        state.items = state.items || {};
        state.log = state.log || [];
        const old = state.items[id] || {};
        const err = check(role, group, old, patch);
        if (err) return res.status(403).json({ error: err });
        const next = { ...old, ...patch, updatedAt: Date.now(), by: who };
        if (patch.reviewNote) {
          delete next.reviewNote;
          next.reviewNotes = [...(old.reviewNotes || []), { text: String(patch.reviewNote).slice(0, 2000), at: Date.now(), by: who }];
        }
        state.items[id] = next;
        if (label) state.log.unshift({ id, label, by: who, at: Date.now() });
        state.log = state.log.slice(0, 60);
        const w = await write(state, sha, `${id}: ${label || 'update'}`);
        if (w.ok) return res.status(200).json({ ...state, role, who });
        if (w.status !== 409 && w.status !== 422) throw new Error('GitHub write ' + w.status);
        await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
      }
      return res.status(409).json({ error: 'CONFLICT' });
    }
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
