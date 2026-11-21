'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const results = [];

function assert(name, cond, detail) {
  if (cond) { passed++; results.push('PASS ' + name); }
  else { failed++; results.push('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')) : null;
    const h = Object.assign({}, headers || {});
    if (data && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let j = null; try { j = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json: j, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'linjian-smoke-'));
  const port = await freePort();
  const adminPort = await freePort();
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
  const password = config.adminAccount.password;
  const env = Object.assign({}, process.env, {
    PORT: String(port), ADMIN_PORT: String(adminPort), HOST: '127.0.0.1', DATA_DIR: tmp,
    CONFIG_PATH: path.join(ROOT, 'config.example.json')
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', ready = false, adminReady = false;
  child.stdout.on('data', d => {
    out += d.toString();
    if (/READY\s+\d+/.test(out)) ready = true;
    if (/ADMIN READY\s+\d+/.test(out)) adminReady = true;
  });
  child.stderr.on('data', d => { err += d.toString(); });
  child.on('error', e => { err += e.message; });

  const deadline = Date.now() + 15000;
  while ((!ready || !adminReady) && Date.now() < deadline && !child.exitCode) await new Promise(r => setTimeout(r, 80));
  assert('server prints READY <public port>', ready, 'stdout=' + out.trim() + ' stderr=' + err.trim());
  assert('server prints ADMIN READY <admin port>', adminReady, 'stdout=' + out.trim() + ' stderr=' + err.trim());
  if (!ready || !adminReady) {
    results.push('SERVER STDERR: ' + err.trim());
    child.kill(); await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return finish();
  }

  const pub = (m, p, b, h) => request(port, m, p, b, h);
  const adm = (m, p, b, h) => request(adminPort, m, p, b, h);
  let r;

  // ---- 主站公开接口 ----
  r = await pub('GET', '/api/health');
  assert('public health 200', r.status === 200 && r.json.ok === true, r.text.slice(0, 160));
  r = await pub('GET', '/api/bootstrap');
  assert('public bootstrap anonymous has no admin flag', r.status === 200 && r.json.admin === false && r.json.user === null && r.json.site.theme.mode === 'auto', r.text.slice(0, 220));
  assert('bootstrap exposes admin site url', !!r.json.urls && !!r.json.urls.admin && !!r.json.urls.adminOrigin && !!r.json.urls.adminPort, r.text.slice(0, 220));
  assert('public bootstrap no secret', !/passwordHash|passwordSalt|appkey|secret/i.test(r.text));
  r = await pub('GET', '/api/posts');
  assert('posts seeded, no body field', r.status === 200 && r.json.posts.length >= 4 && !('body' in r.json.posts[0]), r.text.slice(0, 180));
  const firstSlug = r.json.posts[0].slug;
  r = await pub('GET', '/api/posts/' + encodeURIComponent(firstSlug));
  assert('post detail includes body', r.status === 200 && typeof r.json.post.body === 'string');
  r = await pub('GET', '/api/posts/no-such-post');
  assert('unknown post 404', r.status === 404 && r.json.error === 'NOT_FOUND');
  r = await pub('GET', '/api/projects');
  assert('projects seeded', r.status === 200 && r.json.projects.length >= 3);
  r = await pub('GET', '/api/rss');
  assert('rss xml', r.status === 200 && /application\/rss\+xml/.test(r.headers['content-type'] || '') && r.text.includes('<item>'));
  r = await pub('GET', '/api/comments?post=' + encodeURIComponent(firstSlug));
  assert('comments GET ok', r.status === 200 && Array.isArray(r.json.comments));
  r = await pub('GET', '/api/comments');
  assert('comments missing param 400', r.status === 400);

  // ---- 主站不提供后台入口 ----
  r = await pub('GET', '/');
  assert('public index 200', r.status === 200 && /<html/i.test(r.text));
  assert('public index has no hard-coded /admin link', !r.text.includes('href="/admin"'));
  assert('public index has login entry and admin tab', r.text.includes('id="login-entry"') && r.text.includes('id="admin-tab"') && r.text.includes('id="login-view"'));
  assert('hero has welcome portrait image', r.text.includes('id="hero-portrait"') && /src="\/assets\/hello-baixiaofei\.svg"/.test(r.text));
  assert('force field canvas overlays banner', r.text.indexOf('id="field"') > r.text.indexOf('particle-text-wrap') && r.text.indexOf('id="field"') < r.text.indexOf('<canvas id="pt"') + 300);
  assert('force field visible by default', /<input[^>]+id="showField"[^>]+checked/.test(r.text));
  r = await pub('GET', '/admin');
  assert('public /admin 404', r.status === 404, 'status=' + r.status);
  r = await pub('GET', '/api/admin/overview');
  assert('public admin api 404', r.status === 404 && r.json.error === 'NOT_FOUND', r.text.slice(0, 160));
  r = await pub('POST', '/api/login/admin', { username: config.adminAccount.username, password });
  const publicCookie = (r.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
  const publicAuth = { Cookie: publicCookie, Authorization: 'Bearer ' + (r.json.sessionId || '') };
  assert('public admin login 200 + session', r.status === 200 && r.json.user.nickname === config.adminAccount.username && !!r.json.sessionId && /sid=/.test(publicCookie), r.text.slice(0, 220));
  r = await pub('GET', '/api/me', null, publicAuth);
  assert('public login identifies admin', r.status === 200 && r.json.admin === true, r.text.slice(0, 180));
  r = await pub('GET', '/api/bootstrap', null, publicAuth);
  assert('public bootstrap reflects admin session', r.status === 200 && r.json.admin === true && r.json.user.nickname === config.adminAccount.username, r.text.slice(0, 220));
  r = await pub('GET', '/api/admin/overview', null, publicAuth);
  assert('public read-only admin API still blocked', r.status === 404 && r.json.error === 'NOT_FOUND', r.text.slice(0, 160));
  r = await pub('GET', '/api/admin/content', null, publicAuth);
  assert('public admin content still blocked', r.status === 404 && r.json.error === 'NOT_FOUND', r.text.slice(0, 160));
  r = await pub('POST', '/api/admin/posts', { title: '主站管理员发布测试', slug: 'public-admin-publish', body: '<p>正文</p>' }, publicAuth);
  assert('public surface admin can publish article', r.status === 201 && r.json.post.slug === 'public-admin-publish', r.text.slice(0, 220));
  r = await pub('POST', '/api/admin/posts', { title: '主站管理员更新测试', slug: 'public-admin-publish', body: '<p>已更新</p>' }, publicAuth);
  assert('public surface admin can edit article', r.status === 201 && r.json.post.body === '<p>已更新</p>', r.text.slice(0, 220));
  r = await pub('POST', '/api/admin/posts', { title: '匿名发布测试', slug: 'anon-publish' });
  assert('public surface anonymous publish blocked', r.status === 401, r.text.slice(0, 160));
  r = await pub('POST', '/api/login/dev', { nickname: 'x' });
  assert('public dev login 404', r.status === 404, r.text.slice(0, 160));
  r = await pub('POST', '/api/upload', Buffer.from('x'), { 'Content-Type': 'multipart/form-data; boundary=x' });
  assert('public upload 404', r.status === 404, r.text.slice(0, 160));
  r = await pub('GET', '/assets/app.css');
  assert('assets css served', r.status === 200 && r.text.includes('--bg:#fcfaf8'));
  r = await pub('GET', '/assets/hello-baixiaofei.svg');
  assert('welcome portrait asset served', r.status === 200 && /<svg[\s\S]*你好，这里是白小飞/.test(r.text), r.text.slice(0, 180));
  r = await pub('GET', '/assets/app.js');
  assert('front end login and admin tab flow', r.status === 200 && r.text.includes("'/api/login'") && r.text.includes('admin-tab') && r.text.includes('login-entry') && r.text.includes('state.admin') && r.text.includes("json('/api/admin/posts'"), r.text.slice(0, 180));
  assert('front end keeps force field on hero', r.status === 200 && r.text.includes('window.BlogParticle.init') && r.text.includes('__particleProbe') && r.text.includes('forceProbe'), r.text.slice(0, 180));
  assert('front end never requests missing update-0 image', r.status === 200 && !r.text.includes("'/assets/update-' + i + '.png'") && !r.text.includes("'/assets/update-0.png'"), r.text.slice(0, 180));
  assert('front end hides broken images instead of broken icon', r.status === 200 && r.text.includes('function bindImageFallback') && r.text.includes("addEventListener('error'"), r.text.slice(0, 180));
  assert('global broken image suppression covers article HTML', r.status === 200 && r.text.includes('bindGlobalImageErrors') && r.text.includes('tagName !== \'IMG\''), r.text.slice(0, 180));
  r = await pub('GET', '/assets/particle.js');
  assert('particle canvas matches visible banner stage', r.status === 200 && r.text.includes("document.querySelector('.hero-banner-shader')") && r.text.includes('var r = stage.getBoundingClientRect()'), r.text.slice(0, 180));
  assert('particle initializes visible force canvas', r.status === 200 && r.text.includes('var showFieldEl = document.getElementById(\'showField\')') && r.text.includes('onField();'), r.text.slice(0, 180));
  r = await pub('GET', '/assets/../server.js');
  assert('path traversal rejected', r.status === 403 || r.status === 404, 'status=' + r.status);

  // ---- 访客留言板：全员可见、可匿名 ----
  r = await pub('POST', '/api/guestbook', { nickname: '路过的鲸鱼', text: '第一条全员可见的留言' });
  assert('guestbook anonymous create 201', r.status === 201 && r.json.entry.nickname === '路过的鲸鱼', r.text.slice(0, 200));
  const gbId = r.json.entry.id;
  r = await pub('POST', '/api/guestbook', { nickname: '小明', text: '第二条留言' });
  assert('guestbook second create', r.status === 201);
  const gbId2 = r.json.entry.id;
  r = await pub('POST', '/api/guestbook', { text: '没昵称' });
  assert('guestbook missing nickname 400', r.status === 400 && r.json.error === 'BAD_REQUEST', r.text.slice(0, 180));
  r = await pub('POST', '/api/guestbook', { nickname: 'a', text: '' });
  assert('guestbook empty text 400', r.status === 400);
  r = await pub('GET', '/api/guestbook');
  assert('guestbook publicly visible', r.status === 200 && r.json.guestbook.length === 2 && r.json.guestbook.some(g => g.text === '第一条全员可见的留言'), r.text.slice(0, 220));

  // ---- 文章评论：匿名可发 ----
  r = await pub('POST', '/api/comments', { post: firstSlug, text: '匿名文章评论', nickname: '路人甲' });
  assert('anonymous article comment 201', r.status === 201 && r.json.comment.user.nickname === '路人甲', r.text.slice(0, 200));
  r = await pub('POST', '/api/comments', { post: firstSlug, text: '缺昵称' });
  assert('article comment missing nickname 400', r.status === 400);
  r = await pub('POST', '/api/comments', { post: 'missing', text: 'x', nickname: 'a' });
  assert('article comment unknown post 400', r.status === 400);

  // ---- 管理员账号登录（仅后台站点） ----
  r = await adm('POST', '/api/login/admin', { username: config.adminAccount.username, password: 'wrong-password' });
  assert('admin wrong password 401', r.status === 401 && r.json.error === 'UNAUTHORIZED', r.text.slice(0, 180));
  r = await adm('POST', '/api/login/admin', { username: config.adminAccount.username, password });
  const cookie = (r.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  assert('admin login 200 + sessionId', r.status === 200 && r.json.user.nickname === config.adminAccount.username && r.json.sessionId && /sid=/.test(cookie), r.text.slice(0, 220));
  const auth = { Cookie: cookie, Authorization: 'Bearer ' + r.json.sessionId };
  const adminId = r.json.user.id;
  r = await adm('GET', '/api/me', null, auth);
  assert('admin me admin=true', r.status === 200 && r.json.admin === true, r.text.slice(0, 180));
  r = await adm('GET', '/api/bootstrap', null, auth);
  assert('admin bootstrap admin=true', r.status === 200 && r.json.admin === true);

  // ---- 非管理员不能调整内容 ----
  r = await adm('POST', '/api/login/dev', { nickname: '普通访客' });
  const userCookie = (r.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  const userAuth = { Cookie: userCookie };
  assert('visitor session created', r.status === 200);
  r = await adm('POST', '/api/admin/posts', { title: '不该成功' }, userAuth);
  assert('non-admin POST content 403', r.status === 403 && r.json.error === 'FORBIDDEN', r.text.slice(0, 180));
  r = await adm('POST', '/api/admin/settings', { name: 'hacked' }, userAuth);
  assert('non-admin settings 403', r.status === 403);
  r = await adm('POST', '/api/admin/guestbook/clear', {}, userAuth);
  assert('non-admin clear guestbook 403', r.status === 403);
  r = await adm('POST', '/api/upload', Buffer.from('x'), Object.assign({ 'Content-Type': 'multipart/form-data; boundary=x' }, userAuth));
  assert('non-admin upload 401/403', r.status === 401 || r.status === 403, 'status=' + r.status);
  r = await adm('POST', '/api/admin/posts', { title: '未登录' });
  assert('anonymous admin POST 401', r.status === 401);

  // ---- 主题模式 / 背景自定义设置 ----
  r = await adm('GET', '/api/admin/settings', null, auth);
  assert('admin settings GET', r.status === 200 && r.json.settings && r.json.defaults);
  r = await adm('POST', '/api/admin/settings', {
    name: '白小飞的个人博客', announcement: '三模式 + 留言板',
    theme: { mode: 'dark', accent: '#49b1f5', bgColor: '#0d141c', textColor: '#e8f1f8', cardColor: '#16212c', bgImage: 'https://example.com/bg.png', glow: true, glass: true, grid: true, density: 'compact' },
    heroFx: { radius: 170, strength: 96, trail: 0.42, halo: true },
    links: [{ label: 'GitHub', url: 'https://github.com/' }]
  }, auth);
  assert('settings dark+background POST', r.status === 200 && r.json.settings.theme.mode === 'dark' && r.json.settings.theme.bgImage === 'https://example.com/bg.png', r.text.slice(0, 240));
  r = await adm('POST', '/api/admin/settings', { theme: { mode: 'sepia' } }, auth);
  assert('invalid theme.mode 400', r.status === 400);
  r = await adm('POST', '/api/admin/settings', { theme: { bgImage: 'javascript:alert(1)' } }, auth);
  assert('invalid bgImage 400', r.status === 400, r.text.slice(0, 180));
  r = await adm('POST', '/api/admin/settings', { theme: { accent: 'not-a-color' } }, auth);
  assert('invalid accent 400', r.status === 400);
  r = await pub('GET', '/api/bootstrap');
  assert('public bootstrap reflects dark+background', r.json.site.theme.mode === 'dark' && r.json.site.theme.bgImage === 'https://example.com/bg.png' && r.json.site.theme.bgColor === '#0d141c', r.text.slice(0, 260));
  ['light','dark','auto'].forEach(function () {});
  r = await adm('POST', '/api/admin/settings', { theme: { mode: 'light' } }, auth);
  assert('theme light mode POST', r.status === 200 && r.json.settings.theme.mode === 'light');
  r = await adm('POST', '/api/admin/settings', { theme: { mode: 'auto' } }, auth);
  assert('theme auto mode POST', r.status === 200 && r.json.settings.theme.mode === 'auto');

  // ---- 首页编排 ----
  r = await adm('GET', '/api/admin/layout', null, auth);
  assert('layout GET has modules', r.status === 200 && r.json.layout.modules.length >= 7, r.text.slice(0, 180));
  const reversed = r.json.layout.modules.slice().reverse().map(m => Object.assign({}, m, { visible: m.id !== 'stats' }));
  r = await adm('POST', '/api/admin/layout', { modules: reversed }, auth);
  assert('layout POST reorders', r.status === 200 && r.json.layout.modules[0].id !== 'notice' && !r.json.layout.modules.find(m => m.id === 'stats').visible, r.text.slice(0, 220));
  r = await adm('POST', '/api/admin/layout', { modules: [{ id: 'fake', visible: true }] }, auth);
  assert('layout invalid module 400', r.status === 400);

  // ---- 内容管理 ----
  r = await adm('GET', '/api/admin/content', null, auth);
  assert('content GET includes guestbook', r.status === 200 && r.json.guestbook.length === 2 && r.json.posts.length >= 4, r.text.slice(0, 220));
  r = await adm('GET', '/api/admin/users', null, auth);
  assert('users GET', r.status === 200 && Array.isArray(r.json.users));
  r = await adm('POST', '/api/admin/users/role', { id: adminId, role: 'admin' }, auth);
  assert('users/role POST', r.status === 200 && r.json.user.role === 'admin');
  r = await adm('POST', '/api/admin/comments/delete', { id: 'unknown' }, auth);
  assert('unknown comment delete 404', r.status === 404);
  r = await adm('POST', '/api/admin/posts', { title: '待删除文章', slug: 'to-delete' }, auth);
  assert('create deletable post', r.status === 201);
  r = await adm('POST', '/api/admin/posts/delete', { slug: 'to-delete' }, auth);
  assert('post delete 200', r.status === 200 && r.json.deleted === true);
  r = await pub('GET', '/api/posts/to-delete');
  assert('deleted post gone', r.status === 404);
  r = await adm('POST', '/api/admin/projects', { title: '待删项目' }, auth);
  const pid = r.json.project.id;
  r = await adm('POST', '/api/admin/projects/delete', { id: pid }, auth);
  assert('project delete 200', r.status === 200);

  // ---- 管理员上传背景图 + 删除 ----
  const boundary = '----smoke' + Date.now();
  const fileBody = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="bg.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--' + boundary + '--\r\n', 'utf8');
  r = await adm('POST', '/api/upload', fileBody, Object.assign({ 'Content-Type': 'multipart/form-data; boundary=' + boundary }, auth));
  assert('admin upload 201', r.status === 201 && /^\/uploads\//.test(r.json.file && r.json.file.url), r.text.slice(0, 220));
  const fileUrl = r.json.file.url;
  r = await adm('POST', '/api/admin/settings', { theme: { bgImage: fileUrl } }, auth);
  assert('settings local bgImage accepted', r.status === 200 && r.json.settings.theme.bgImage === fileUrl, r.text.slice(0, 200));
  r = await adm('GET', fileUrl);
  assert('uploaded file readback', r.status === 200 && r.text === 'PNGDATA', r.text.slice(0, 120));
  r = await adm('GET', '/api/uploads', null, auth);
  assert('admin sees uploads', r.status === 200 && r.json.uploads.some(u => u.url === fileUrl));
  r = await adm('POST', '/api/admin/uploads/delete', { name: fileUrl.split('/').pop() }, auth);
  assert('upload delete 200', r.status === 200);
  r = await adm('GET', fileUrl);
  assert('deleted upload 404', r.status === 404);

  // ---- 留言板：管理员删单条 / 清空 ----
  r = await adm('POST', '/api/admin/guestbook/delete', { id: gbId }, auth);
  assert('admin delete one guestbook', r.status === 200 && r.json.deleted === true, r.text.slice(0, 180));
  r = await pub('GET', '/api/guestbook');
  assert('guestbook after single delete', r.json.guestbook.length === 1 && r.json.guestbook[0].id === gbId2, r.text.slice(0, 200));
  r = await adm('POST', '/api/admin/guestbook/delete', { id: 'unknown' }, auth);
  assert('delete unknown guestbook 404', r.status === 404);
  r = await adm('POST', '/api/admin/guestbook/clear', {}, auth);
  assert('admin clear guestbook', r.status === 200 && r.json.cleared === 1, r.text.slice(0, 180));
  r = await pub('GET', '/api/guestbook');
  assert('guestbook empty after clear', r.json.guestbook.length === 0);

  // ---- 修改管理员密码 ----
  r = await adm('POST', '/api/admin/password', { oldPassword: 'wrong', newPassword: 'newpass123' }, auth);
  assert('wrong old password 400', r.status === 400 && r.json.error === 'BAD_REQUEST', r.text.slice(0, 180));
  r = await adm('POST', '/api/admin/password', { oldPassword: password, newPassword: '12345' }, auth);
  assert('too short new password 400', r.status === 400);
  r = await adm('POST', '/api/admin/password', { oldPassword: password, newPassword: 'newpass123' }, auth);
  assert('change password 200', r.status === 200 && r.json.changed === true, r.text.slice(0, 180));
  r = await adm('POST', '/api/login/admin', { username: config.adminAccount.username, password: 'newpass123' });
  assert('login with new password 200', r.status === 200 && r.json.user.role !== undefined || r.status === 200, r.text.slice(0, 180));
  r = await adm('POST', '/api/login/admin', { username: config.adminAccount.username, password });
  assert('old password no longer works', r.status === 401, r.text.slice(0, 160));

  // ---- 后台独立站点静态页 ----
  r = await adm('GET', '/');
  assert('admin root serves admin.html', r.status === 200 && /管理员登录/.test(r.text), r.text.slice(0, 160));
  r = await adm('GET', '/assets/admin.js');
  assert('admin js served', r.status === 200 && r.text.includes('/api/login/admin'));
  // ---- 暗色粒子发光资源与主题接口（静态资源可达） ----
  r = await adm('GET', '/assets/particle.js');
  assert('particle script served', r.status === 200 && r.text.includes("ink: '#fafafa'") && r.text.includes('this.setTheme'), r.text.slice(0, 180));
  assert('particle auto-return loop present', r.text.includes('RETURN_LERP = 0.22') && r.text.includes('setTimeout(tick, pushing ? 16 : TICK_MS)') && r.text.includes('IMPULSE_MS = 110'), r.text.slice(0, 220));
  assert('particle probe exposes displacement', r.text.includes('maxDisp:') && r.text.includes('forceActive:'), r.text.slice(0, 220));
  assert('particle batches draws into grouped paths', r.text.includes('ctx.beginPath();') && r.text.includes('ctx.fill();') && r.text.includes('lastDraw = '), r.text.slice(0, 220));
  assert('particle has heart pattern layer', r.text.includes('HEART') && r.text.includes('heartX') && r.text.includes('heartY') && r.text.includes('arc(') && !r.text.includes('petals'), r.text.slice(0, 220));
  assert('particle heart is layered and visible', r.text.includes('HEART') && /heartX\(t\)/.test(r.text) && r.text.includes('patternPoints(') && r.text.includes('pattern: true') && r.text.includes('q.pattern'), r.text.slice(0, 220));
  assert('particle uses black-white palette', !r.text.includes('#7dd8ff') && !r.text.includes('rgba(73,177,245') && r.text.includes("ink: '#fafafa'"), r.text.slice(0, 220));
  assert('pointermove does not redraw whole canvas', !/function onMove\(e\)\{[\s\S]*?drawStatic\(\)/.test(r.text), r.text.slice(0, 220));
  r = await adm('GET', '/assets/hero-banner.jpg');
  assert('hero banner poster asset served', r.status === 200 && r.raw.length > 50000, 'status=' + r.status + ' bytes=' + r.raw.length);
  r = await adm('GET', '/assets/app.css');
  assert('dark particle glow css served', r.status === 200 && r.text.includes("body[data-theme=\"dark\"] #pt{filter:none}") && r.text.includes('.hero-caption .sub'), r.text.slice(0, 180));
  assert('no per-frame canvas CSS filter', r.status === 200 && !r.text.includes('#pt{filter:drop-shadow'), r.text.slice(0, 180));
  assert('dark text contrast uses neutral grayscale', r.text.includes('--ink:#fafafa') && r.text.includes('--sub:#c7c7c7') && r.text.includes('--muted:#9a9a9a') && !r.text.includes('#7dd8ff') && !r.text.includes('73,177,245'), r.text.slice(0, 180));
  assert('all surfaces use theme variables', !/background:\s*#fff\b/i.test(r.text) && !/background:\s*rgba\(255,\s*255,\s*255/i.test(r.text) && !/background:\s*rgba\(248,\s*248,\s*248/i.test(r.text), r.text.slice(0, 220));
  assert('mimo layout classes present', r.text.includes('.hero-banner-shader') && r.text.includes('.particle-text-wrap') && r.text.includes('.model-card') && r.text.includes('.home-section') && r.text.includes('.page-dots'), r.text.slice(0, 220));
  assert('reference page full css structure', r.text.includes('--card:#faf7f3') && r.text.includes('--border-warm:#f0ebe5') && r.text.includes('.ecosystem-grid') && r.text.includes('.voices-section') && r.text.includes('.site-footer'), r.text.slice(0, 220));
  assert('spring bounce motion present', r.text.includes('cubic-bezier(.34,1.56,.64,1)'), r.text.slice(0, 180));
  r = await adm('GET', '/assets/app.js');
  assert('theme switch syncs particle', r.status === 200 && r.text.includes('bootstrap.particle.setTheme'), r.text.slice(0, 180));
  assert('carousel pagination wired', r.text.includes('renderCarousel') && r.text.includes('carouselIndex') && r.text.includes('page-dots'), r.text.slice(0, 180));
  assert('hero typing lines wired', r.text.includes('hero-line') && r.text.includes('typingLine'), r.text.slice(0, 180));
  r = await pub('GET', '/');
  assert('home markup follows reference structure', r.text.includes('hero-banner-shader') && r.text.includes('particle-text-wrap') && r.text.includes('updates-layout') && r.text.includes('product-accordion'), r.text.slice(0, 180));
  assert('home follows full reference section order', (function(){
    var h=r.text, order=['home-page','home-nav','hero-content','hero-banner-shader','updates-section','models-section','products-section','ecosystem-section','voices-section','about-section','site-footer'];
    var last=-1; for(var i=0;i<order.length;i++){var k=h.indexOf(order[i]); if(k<0||k<last)return false; last=k;} return true;
  })(), r.text.slice(0, 180));
  r = await adm('GET', '/README.md').catch(() => ({ status: 404, text: '' }));
  if (r.status === 200) assert('readme avoids reference brand name', !/MiMo|小米/i.test(r.text) && r.text.includes('极简黑白风格'), r.text.slice(0, 180));

  // ---- 注册账号 / 精确登录 / 首页粒子与历史文章回归（用户 m00764） ----
  r = await pub('GET', '/assets/particle.js');
  assert('onField must not rely on this binding (strict mode)', r.status === 200 && /function onField\(\)\s*\{[^}]*showFieldEl\.checked/.test(r.text) && !/function onField\(\)\s*\{[^}]*this\.checked/.test(r.text), r.text.slice(0, 180));
  r = await pub('GET', '/assets/app.css');
  assert('welcome portrait has readable opacity', r.status === 200 && /\.hero-portrait\{[^}]*opacity:\.([6-9]|1)/.test(r.text), (r.text.match(/\.hero-portrait\{[^}]*\}/)||[''])[0]);
  r = await pub('GET', '/');
  assert('index has register entry and view', r.text.includes('id="register-entry"') && r.text.includes('id="register-view"') && r.text.includes('id="register-submit"'), r.text.slice(0, 180));
  r = await pub('GET', '/assets/app.js');
  assert('frontend implements register and precise login errors', r.status === 200 && r.text.includes("'/api/register'") && r.text.includes("'/api/login'") && r.text.includes('function submitRegister') && r.text.includes('account-error') && r.text.includes('register-message'), r.text.slice(0, 180));
  r = await pub('POST', '/api/register', { username: 'newstudent', password: 'regpass123', nickname: '新同学' });
  const regCookie = (r.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  assert('public register creates user + session', r.status === 201 && r.json.user && r.json.user.nickname === '新同学' && !!r.json.sessionId, r.text.slice(0, 220));
  r = await pub('POST', '/api/register', { username: 'newstudent', password: 'regpass123', nickname: '又一个人' });
  assert('duplicate register rejected with clear message', r.status === 409 && /已被注册|已存在/.test(r.text), r.text.slice(0, 200));
  r = await pub('POST', '/api/login', { username: 'newstudent', password: 'regpass123' });
  assert('generic login works for registered user', r.status === 200 && r.json.user.nickname === '新同学', r.text.slice(0, 200));
  r = await pub('POST', '/api/login', { username: 'no-such-account', password: 'whatever' });
  assert('login wrong account gives explicit account error', r.status === 401 && /账号/.test(r.text) && !/密码错误/.test(r.text), r.text.slice(0, 200));
  r = await pub('POST', '/api/login', { username: 'newstudent', password: 'wrong-password' });
  assert('login wrong password gives explicit password error', r.status === 401 && /密码/.test(r.text) && !/账号不存在/.test(r.text), r.text.slice(0, 200));
  r = await pub('POST', '/api/guestbook', { text: '注册用户留言' }, { Cookie: regCookie });
  assert('registered user guestbook uses own nickname', r.status === 201 && r.json.entry.nickname === '新同学', r.text.slice(0, 200));
  r = await pub('GET', '/api/guestbook');
  assert('guestbook shows who left each message', r.status === 200 && r.json.guestbook.some(g => g.nickname === '新同学' && g.text === '注册用户留言'), r.text.slice(0, 220));

  r = await adm('GET', '/api/does-not-exist');
  assert('unknown API 404 JSON', r.status === 404 && r.json.error === 'NOT_FOUND');
  r = await adm('POST', '/api/logout', {}, auth);
  assert('logout ok', r.status === 200);
  r = await adm('GET', '/api/me', null, auth);
  assert('session invalid after logout', r.status === 401);

  child.kill();
  await new Promise(r => setTimeout(r, 150));
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  finish();
}

function finish() {
  console.log(results.join('\n'));
  console.log('RESULT ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
