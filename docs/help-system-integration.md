# MySpark+ Help Center Integration Guide

Drop-in code for the Help Center feature. Three pieces: CSS, JS module, and the wiring for your existing Help menu link. Then upload the articles to S3 and deploy index.html.

---

## Step 1: Add the CSS

Paste this block inside your existing `<style>` section in index.html, anywhere near the bottom of your existing styles (so it can override if needed).

```css
/* ============================================================
   Help Center
   ============================================================ */
.help-root {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 24px;
  height: 100%;
  min-height: 500px;
}
@media (max-width: 768px) {
  .help-root { grid-template-columns: 1fr; }
  .help-sidebar { border-right: none; border-bottom: 1px solid var(--border, #e5e7eb); padding-bottom: 16px; }
}

.help-sidebar {
  padding: 16px 16px 16px 0;
  border-right: 1px solid var(--border, #e5e7eb);
  overflow-y: auto;
}
.help-sidebar h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted, #6b7280);
  margin: 16px 0 8px 12px;
  font-weight: 600;
}
.help-cat {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--fg, #111827);
  user-select: none;
  transition: background 0.12s;
}
.help-cat:hover { background: var(--hover, #f3f4f6); }
.help-cat.active { background: var(--primary-soft, rgba(107, 33, 234, 0.08)); color: var(--primary, #6b21ea); font-weight: 600; }
.help-cat .help-cat-icon { font-size: 16px; line-height: 1; }
.help-cat .help-cat-admin { margin-left: auto; font-size: 10px; text-transform: uppercase; opacity: 0.6; letter-spacing: 0.5px; }

.help-content { padding: 16px 8px 32px; overflow-y: auto; }

.help-search-wrap { position: relative; margin-bottom: 20px; }
.help-search {
  width: 100%;
  padding: 10px 14px 10px 38px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  font-size: 14px;
  background: var(--bg, #fff);
  color: var(--fg, #111827);
  outline: none;
}
.help-search:focus { border-color: var(--primary, #6b21ea); box-shadow: 0 0 0 3px rgba(107, 33, 234, 0.12); }
.help-search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  opacity: 0.5;
  font-size: 14px;
}

.help-header { margin-bottom: 16px; }
.help-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--fg, #111827); }
.help-header .help-header-sub { color: var(--muted, #6b7280); font-size: 14px; }

.help-article-grid { display: grid; gap: 10px; }
.help-article-card {
  padding: 16px 18px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  cursor: pointer;
  background: var(--bg, #fff);
  transition: border-color 0.12s, transform 0.12s;
}
.help-article-card:hover { border-color: var(--primary, #6b21ea); transform: translateY(-1px); }
.help-article-card .help-article-title { font-weight: 600; font-size: 15px; color: var(--fg, #111827); margin-bottom: 4px; }
.help-article-card .help-article-summary { color: var(--muted, #6b7280); font-size: 13px; line-height: 1.5; }
.help-article-card .help-article-meta { display: flex; gap: 10px; margin-top: 8px; font-size: 11px; color: var(--muted, #9ca3af); }
.help-article-card .help-pill {
  display: inline-block;
  padding: 2px 8px;
  background: var(--primary-soft, rgba(107, 33, 234, 0.08));
  color: var(--primary, #6b21ea);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.help-empty { padding: 40px 20px; text-align: center; color: var(--muted, #6b7280); }
.help-loading { padding: 40px 20px; text-align: center; color: var(--muted, #6b7280); }

.help-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--primary, #6b21ea);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  padding: 4px 0;
  margin-bottom: 16px;
}
.help-back:hover { text-decoration: underline; }

.help-reader { max-width: 720px; }
.help-reader h1 { font-size: 26px; font-weight: 700; margin: 0 0 8px; color: var(--fg, #111827); }
.help-reader .help-reader-meta { color: var(--muted, #9ca3af); font-size: 12px; margin-bottom: 24px; }
.help-reader .help-p { font-size: 15px; line-height: 1.65; color: var(--fg, #1f2937); margin: 12px 0; }
.help-reader .help-h2 { font-size: 17px; font-weight: 600; margin: 28px 0 10px; color: var(--fg, #111827); }
.help-reader .help-ul, .help-reader .help-ol, .help-reader .help-steps { margin: 12px 0; padding-left: 24px; }
.help-reader .help-ul li, .help-reader .help-ol li { font-size: 14px; line-height: 1.6; color: var(--fg, #1f2937); margin: 6px 0; }
.help-reader .help-steps { list-style: none; padding-left: 0; counter-reset: step; }
.help-reader .help-steps li {
  counter-increment: step;
  position: relative;
  padding: 10px 14px 10px 44px;
  margin: 8px 0;
  background: var(--hover, #f9fafb);
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
}
.help-reader .help-steps li::before {
  content: counter(step);
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  background: var(--primary, #6b21ea);
  color: white;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.help-reader .help-tip, .help-reader .help-warn {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 8px;
  margin: 16px 0;
  font-size: 14px;
  line-height: 1.5;
}
.help-reader .help-tip { background: rgba(16, 185, 129, 0.08); border-left: 3px solid #10b981; color: #065f46; }
.help-reader .help-warn { background: rgba(245, 158, 11, 0.1); border-left: 3px solid #f59e0b; color: #92400e; }
.help-reader .help-callout-label { font-weight: 700; flex-shrink: 0; }

.help-search-hit { background: rgba(245, 208, 64, 0.4); border-radius: 2px; padding: 0 1px; }
```

---

## Step 2: Add the JS module

Paste this block inside your existing `<script>` section in index.html, anywhere after `state` is defined and before any code that references `showHelpView()`.

```javascript
/* ============================================================
   Help Center
   ============================================================ */
const helpState = {
  loaded: false,
  loading: false,
  data: null,
  currentCategory: null,
  currentArticle: null,
  searchQuery: '',
  containerSel: null
};

function helpIsAdmin() {
  // Adjust if your role names differ
  const role = (state && state.user && state.user.role) || '';
  return role === 'admin' || role === 'super_admin';
}

function helpEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function helpHighlight(text, query) {
  const escaped = helpEscape(text);
  if (!query) return escaped;
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + q + ')', 'gi'), '<span class="help-search-hit">$1</span>');
}

async function loadHelpData() {
  if (helpState.loaded || helpState.loading) return helpState.data;
  helpState.loading = true;
  try {
    const res = await fetch('/help-articles.json?v=' + Date.now(), { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    helpState.data = await res.json();
    helpState.loaded = true;
  } catch (e) {
    console.error('[help] load failed', e);
    helpState.data = { categories: [], articles: [] };
  } finally {
    helpState.loading = false;
  }
  return helpState.data;
}

function helpGetVisibleArticles() {
  if (!helpState.data) return [];
  const admin = helpIsAdmin();
  let articles = helpState.data.articles.filter(a => admin || a.audience === 'all');

  // Search filter
  const q = helpState.searchQuery.trim().toLowerCase();
  if (q) {
    articles = articles.filter(a => {
      const hay = [
        a.title,
        a.summary || '',
        (a.tags || []).join(' '),
        (a.body || []).map(b => b.text || (b.items || []).join(' ')).join(' ')
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  // Category filter
  if (helpState.currentCategory) {
    articles = articles.filter(a => a.category === helpState.currentCategory);
  }

  return articles;
}

function helpGetVisibleCategories() {
  if (!helpState.data) return [];
  const admin = helpIsAdmin();
  const visibleCats = helpState.data.categories
    .filter(c => admin || c.audience === 'all')
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  // Only include categories that have at least one article visible to this user
  const articleCats = new Set(helpState.data.articles
    .filter(a => admin || a.audience === 'all')
    .map(a => a.category));
  return visibleCats.filter(c => articleCats.has(c.id));
}

function helpRenderBlock(block, q) {
  if (!block || !block.type) return '';
  switch (block.type) {
    case 'p':    return '<p class="help-p">' + helpHighlight(block.text || '', q) + '</p>';
    case 'h2':   return '<h2 class="help-h2">' + helpHighlight(block.text || '', q) + '</h2>';
    case 'ul':   return '<ul class="help-ul">' + (block.items || []).map(i => '<li>' + helpHighlight(i, q) + '</li>').join('') + '</ul>';
    case 'ol':   return '<ol class="help-ol">' + (block.items || []).map(i => '<li>' + helpHighlight(i, q) + '</li>').join('') + '</ol>';
    case 'steps':return '<ol class="help-steps">' + (block.items || []).map(i => '<li>' + helpHighlight(i, q) + '</li>').join('') + '</ol>';
    case 'tip':  return '<div class="help-tip"><span class="help-callout-label">Tip</span><span>' + helpHighlight(block.text || '', q) + '</span></div>';
    case 'warn': return '<div class="help-warn"><span class="help-callout-label">Heads up</span><span>' + helpHighlight(block.text || '', q) + '</span></div>';
    default: return '';
  }
}

function helpRenderSidebar() {
  const cats = helpGetVisibleCategories();
  const all = !helpState.currentCategory ? 'active' : '';
  let html = '<h3>Browse</h3>';
  html += '<div class="help-cat ' + all + '" onclick="helpSelectCategory(null)">';
  html += '<span class="help-cat-icon">📚</span><span>All articles</span></div>';
  cats.forEach(c => {
    const active = helpState.currentCategory === c.id ? 'active' : '';
    html += '<div class="help-cat ' + active + '" onclick="helpSelectCategory(\'' + helpEscape(c.id) + '\')">';
    html += '<span class="help-cat-icon">' + helpEscape(c.icon || '📄') + '</span>';
    html += '<span>' + helpEscape(c.name) + '</span>';
    if (c.audience === 'admin') html += '<span class="help-cat-admin">Admin</span>';
    html += '</div>';
  });
  return html;
}

function helpRenderArticleList() {
  const q = helpState.searchQuery.trim();
  const articles = helpGetVisibleArticles();
  const catName = helpState.currentCategory
    ? (helpState.data.categories.find(c => c.id === helpState.currentCategory) || {}).name
    : 'All articles';

  let html = '';
  html += '<div class="help-header">';
  html += '<h1>' + helpEscape(q ? 'Search results' : (catName || 'Help')) + '</h1>';
  html += '<div class="help-header-sub">' + articles.length + ' article' + (articles.length === 1 ? '' : 's') + (q ? ' matching "' + helpEscape(q) + '"' : '') + '</div>';
  html += '</div>';

  if (articles.length === 0) {
    html += '<div class="help-empty">No articles found. Try a different search term or category.</div>';
    return html;
  }

  html += '<div class="help-article-grid">';
  articles.forEach(a => {
    html += '<div class="help-article-card" onclick="helpOpenArticle(\'' + helpEscape(a.id) + '\')">';
    html += '<div class="help-article-title">' + helpHighlight(a.title, q) + '</div>';
    if (a.summary) html += '<div class="help-article-summary">' + helpHighlight(a.summary, q) + '</div>';
    html += '<div class="help-article-meta">';
    if (a.audience === 'admin') html += '<span class="help-pill">Admin</span>';
    if (a.updated) html += '<span>Updated ' + helpEscape(a.updated) + '</span>';
    html += '</div></div>';
  });
  html += '</div>';
  return html;
}

function helpRenderArticleReader() {
  const article = helpState.data.articles.find(a => a.id === helpState.currentArticle);
  if (!article) {
    helpState.currentArticle = null;
    return helpRenderArticleList();
  }
  const q = helpState.searchQuery.trim();
  let html = '<button class="help-back" onclick="helpBackToList()">← Back to articles</button>';
  html += '<div class="help-reader">';
  html += '<h1>' + helpHighlight(article.title, q) + '</h1>';
  html += '<div class="help-reader-meta">';
  if (article.audience === 'admin') html += '<span class="help-pill">Admin</span> ';
  if (article.updated) html += 'Updated ' + helpEscape(article.updated);
  html += '</div>';
  (article.body || []).forEach(block => { html += helpRenderBlock(block, q); });
  html += '</div>';
  return html;
}

function helpRenderUI() {
  const container = document.querySelector(helpState.containerSel);
  if (!container) return;

  let inner = '';
  if (helpState.loading && !helpState.data) {
    inner = '<div class="help-loading">Loading help...</div>';
  } else {
    inner = '<div class="help-root">';
    inner += '<aside class="help-sidebar">' + helpRenderSidebar() + '</aside>';
    inner += '<section class="help-content">';
    inner += '<div class="help-search-wrap"><span class="help-search-icon">🔍</span>';
    inner += '<input type="text" class="help-search" placeholder="Search help articles..." ';
    inner += 'value="' + helpEscape(helpState.searchQuery) + '" ';
    inner += 'oninput="helpSearchInput(this.value)" />';
    inner += '</div>';
    if (helpState.currentArticle) {
      inner += helpRenderArticleReader();
    } else {
      inner += helpRenderArticleList();
    }
    inner += '</section></div>';
  }
  container.innerHTML = inner;

  // Keep search focused while typing
  if (helpState.searchQuery) {
    const input = container.querySelector('.help-search');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

async function showHelpView(containerSelector) {
  helpState.containerSel = containerSelector || '#mainContent';
  helpRenderUI();
  if (!helpState.loaded) {
    await loadHelpData();
    helpRenderUI();
  }
}

function helpSelectCategory(id) {
  helpState.currentCategory = id;
  helpState.currentArticle = null;
  helpRenderUI();
}

function helpOpenArticle(id) {
  helpState.currentArticle = id;
  helpRenderUI();
}

function helpBackToList() {
  helpState.currentArticle = null;
  helpRenderUI();
}

let _helpSearchTimer = null;
function helpSearchInput(val) {
  helpState.searchQuery = val;
  clearTimeout(_helpSearchTimer);
  _helpSearchTimer = setTimeout(() => {
    helpState.currentArticle = null;
    helpRenderUI();
  }, 150);
}
```

---

## Step 3: Wire the Help menu link

Find the Help link you added to the left menu. Update its click handler to call `showHelpView()` with your main content container selector.

Example, if your menu items use an onclick pattern:

```html
<a class="menu-item" onclick="showHelpView('#mainContent')">
  Help
</a>
```

Or if you use a router pattern with a route handler, add a case:

```javascript
case 'help':
  showHelpView('#mainContent');
  break;
```

Replace `#mainContent` with whatever selector you use for the main view container.

---

## Step 4: Adjust the admin role check (if needed)

Open the JS block and find this function:

```javascript
function helpIsAdmin() {
  const role = (state && state.user && state.user.role) || '';
  return role === 'admin' || role === 'super_admin';
}
```

Match the role values your app uses. If your admin role is named differently (e.g., `'owner'`, `'manager'`), update the comparison.

---

## Step 5: Deploy

Upload the JSON file to S3, then deploy index.html.

```bash
echo "🟢 START"
cd ~/Downloads/myspark-crm-repo

echo "🟢 1. Upload help-articles.json to S3"
aws s3 cp ~/Downloads/help-articles.json s3://myspark-app-www/help-articles.json \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/json" \
  --region us-east-2

echo ""
echo "🟢 2. Move JSON into repo for source control"
mv ~/Downloads/help-articles.json ~/Downloads/myspark-crm-repo/help-articles.json

echo ""
echo "🟢 3. Validate index.html"
cat > /tmp/parse_html.js << 'EOF'
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;
let m, scripts = [];
while ((m = re.exec(html)) !== null) scripts.push(m[1]);
const main = scripts.reduce((a, b) => a.length > b.length ? a : b, '');
try { require('vm').compileFunction(main, []); console.log('OK index.html'); }
catch(e) { console.log('PARSE ERROR:', e.message); process.exit(1); }
EOF
node /tmp/parse_html.js

echo ""
echo "🟢 4. Upload index.html to S3"
aws s3 cp index.html s3://myspark-app-www/index.html \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html" \
  --region us-east-2

echo ""
echo "🟢 5. Invalidate CloudFront"
aws cloudfront create-invalidation \
  --distribution-id EELLOP01UKIZV \
  --paths "/index.html" "/" "/help-articles.json" \
  --query 'Invalidation.Id' --output text

echo ""
echo "🟢 6. Stage in git"
cd ~/Downloads/myspark-crm-repo
git add index.html help-articles.json
git status

echo "🟢 END"
```

After the status shows clean staging, commit and push:

```bash
git commit -m "Add Help Center feature with 8 starter articles"
git push origin main
```

---

## Adding more articles

To add a new article later:

1. Edit `help-articles.json` in the repo
2. Add an object to the `articles` array with this shape:

```json
{
  "id": "unique-slug",
  "title": "Your article title",
  "category": "category-id",
  "audience": "all",
  "tags": ["search", "keywords"],
  "summary": "One-line preview",
  "updated": "2026-05-15",
  "body": [
    { "type": "p", "text": "Paragraph text." },
    { "type": "h2", "text": "A subheading" },
    { "type": "steps", "items": ["Step 1", "Step 2"] },
    { "type": "tip", "text": "A helpful aside." }
  ]
}
```

3. Upload the JSON to S3 (same command as step 1 above) and invalidate CloudFront

Block types supported:
- `p` — paragraph
- `h2` — subheading
- `ul` — bullet list (use `items`)
- `ol` — numbered list (use `items`)
- `steps` — numbered steps with styled badges (use `items`)
- `tip` — green tip callout
- `warn` — amber warning callout

To add a new category:

1. Add a category object to the `categories` array
2. Set `audience` to `"all"` or `"admin"`
3. Pick an emoji icon

---

## Test checklist

After deploy, hard refresh and verify:

1. Click Help in the left menu, the Help center loads
2. Categories show in the sidebar (admin sees all 8, staff sees 4)
3. Clicking a category filters the article list
4. Clicking an article opens the reader view
5. Back button returns to the list
6. Search filters articles in real time and highlights matches
7. Admin-only categories and articles hide from a staff user
8. Mobile width: sidebar stacks above content

---

## What's intentionally NOT in v1

Saving for later if you want it:

- Inline images and screenshots
- Article ratings or feedback ("Was this helpful?")
- Video embeds
- Per-article view tracking
- Article author bylines
- Related articles section
- Print-friendly view

Each of these is a small add when you want it.
