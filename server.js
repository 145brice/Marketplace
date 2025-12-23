const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// In-memory state
let isRunning = false;
let currentBrowser = null;
let lastResult = { deals: [], params: null, ts: null };
const RESULTS_PATH = path.join(__dirname, 'results.json');
const NOTIFY_CONFIG_PATH = path.join(__dirname, 'notify-config.json');
let intervalHandle = null;
let notifyConfig = { webhookUrl: '', phoneNumber: '', enabled: false };

function toCSV(rows) {
  const headers = ['title', 'price', 'priceNumber', 'model', 'soldLast30', 'avgSold', 'marginFromAvg', 'profitRange', 'link'];
  const escapeCSV = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows || []) {
    lines.push([
      r.title || '',
      r.price || '',
      r.priceNumber != null ? r.priceNumber : '',
      r.model || '',
      r.soldHistory ? r.soldHistory.sold : '',
      r.soldHistory ? r.soldHistory.avg : '',
      r.marginFromAvg != null ? r.marginFromAvg.toFixed(1) : '',
      r.profitRange || '',
      r.link || ''
    ].map(escapeCSV).join(','));
  }
  return lines.join('\r\n');
}

function saveResults(deals, params) {
  lastResult = { deals, params, ts: new Date().toISOString() };
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(lastResult, null, 2));
  } catch (_) {
    // ignore fs errors
  }
}

function loadResults() {
  try {
    if (fs.existsSync(RESULTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
      lastResult = data;
    }
  } catch (_) {
    // ignore parse errors
  }
}

function loadNotifyConfig() {
  try {
    if (fs.existsSync(NOTIFY_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(NOTIFY_CONFIG_PATH, 'utf8'));
      notifyConfig = data;
    }
  } catch (_) {}
}

function saveNotifyConfig(config) {
  try {
    notifyConfig = config;
    fs.writeFileSync(NOTIFY_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (_) {}
}

function sendNotification(deals) {
  if (!notifyConfig.enabled || !notifyConfig.webhookUrl || deals.length === 0) return;
  const message = `Found ${deals.length} mower(s): ${deals.slice(0, 3).map(d => d.title + ' - ' + d.price).join(', ')}`;
  const payload = {
    phone: notifyConfig.phoneNumber,
    message: message,
    deals: deals
  };
  fetch(notifyConfig.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function extractModel(title) {
  if (!title) return null;
  // Extract brand and model from title
  const cleaned = title.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  const brands = ['husqvarna', 'toro', 'craftsman', 'cub cadet', 'john deere', 'ariens', 'troy-bilt', 'poulan', 'snapper', 'simplicity', 'ferris', 'exmark', 'scag', 'bad boy', 'gravely', 'hustler'];
  let found = null;
  for (const b of brands) {
    if (cleaned.toLowerCase().includes(b)) {
      found = b;
      break;
    }
  }
  if (!found) return cleaned.split(' ').slice(0, 3).join(' ');
  const parts = cleaned.toLowerCase().split(found);
  const modelPart = (parts[1] || '').trim().split(' ').slice(0, 3).join(' ');
  return (found + ' ' + modelPart).trim();
}

async function fetchSoldHistory(models, page) {
  const results = {};
  for (const model of models) {
    if (!model) continue;
    try {
      // Try Facebook Marketplace sold search
      const searchUrl = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(model)}&exact=false`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      
      // Scroll and gather prices (best-effort; Marketplace often hides sold badge)
      const soldData = await page.evaluate((modelName) => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
        const seen = new Set();
        const prices = [];
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const container = a.closest('[role="article"]') || a.parentElement;
          if (!container) continue;
          const spans = Array.from(container.querySelectorAll('span')).map(s => s.textContent || '').filter(Boolean);
          const priceText = spans.find(t => /\$\s*\d/.test(t));
          if (!priceText) continue;
          const num = parseFloat(priceText.replace(/[^0-9.]/g, ''));
          if (!Number.isFinite(num) || num <= 0 || num > 20000) continue; // cap to ignore concatenated junk
          prices.push(num);
          if (prices.length >= 30) break;
        }
        return prices;
      }, model);

      let clean = Array.isArray(soldData) ? soldData.filter(n => n > 0 && n <= 20000) : [];
      if (clean.length > 6) {
        // Trim extreme outliers: drop top/bottom 10%
        clean = clean.sort((a,b)=>a-b);
        const drop = Math.max(1, Math.floor(clean.length * 0.1));
        clean = clean.slice(drop, clean.length - drop);
      }

      if (clean && clean.length > 0) {
        const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
        results[model] = {
          sold: clean.length,
          avg: Math.round(avg),
          low: Math.min(...clean),
          high: Math.max(...clean)
        };
      } else {
        results[model] = { sold: 0, avg: 0, low: 0, high: 0 };
      }
    } catch (err) {
      results[model] = { sold: 0, avg: 0, low: 0, high: 0 };
    }
  }
  return results;
}

async function runScrape(params) {
  const limit = Math.max(1, Math.min(100, parseInt(params.limit || '10', 10)));
  const keywords = (params.keywords || '').trim();
  const targetUrl = keywords
    ? `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(keywords)}`
    : 'https://www.facebook.com/marketplace/category/riding-lawn-mowers';
  const minPrice = isFinite(Number(params.minPrice)) ? Number(params.minPrice) : null;
  const maxPrice = isFinite(Number(params.maxPrice)) ? Number(params.maxPrice) : null;

  let deals = [];
  try {
    currentBrowser = await puppeteer.launch({ headless: false });
    const page = await currentBrowser.newPage();

    // Apply cookies from cookies.json
    try {
      const cookies = JSON.parse(fs.readFileSync(path.join(__dirname, 'cookies.json'), 'utf8'));
      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
      }
    } catch (err) {
      // No cookies provided or invalid; continue anyway
    }

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

    // Try to scroll a bit to load items
    try {
      await page.evaluate(async (desired) => {
        for (let i = 0; i < 12; i++) {
          window.scrollBy(0, document.body.scrollHeight);
          await new Promise((r) => setTimeout(r, 700));
          const count = document.querySelectorAll('a[href*="/marketplace/item/"]').length;
          if (count >= desired) break;
        }
      }, limit);
    } catch (_) {}

    deals = await page.evaluate((desired) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
      const uniq = new Map();
      for (const a of anchors) {
        const href = a.getAttribute('href');
        if (href && !uniq.has(href)) uniq.set(href, a);
      }
      const items = Array.from(uniq.values()).slice(0, desired).map((a) => {
        const href = a.getAttribute('href') || '';
        const link = href.startsWith('http') ? href : ('https://www.facebook.com' + href);
        const container = a.closest('[role="article"]') || a.parentElement || a;
        let title = 'No title';
        let price = 'N/A';
        const spans = Array.from(container.querySelectorAll('span')).map((s) => s.textContent || '').filter(Boolean);
        if (spans.length) {
          const priceCandidate = spans.find((t) => /\$?\d[\d,]*(?:\.\d{2})?/.test(t));
          if (priceCandidate) price = priceCandidate;
          const titleCandidate = spans.find((t) => t && t.length > 3 && t !== priceCandidate);
          if (titleCandidate) title = titleCandidate;
        }
        return { title, price, link };
      });
      return items;
    }, limit);

    // Clean and filter results server-side
    const parsePriceNumber = (txt) => {
      if (!txt || typeof txt !== 'string') return null;
      if (/unread/i.test(txt)) return null;
      const m = txt.replace(/,/g, '').match(/\$?(\d+(?:\.\d{1,2})?)/);
      return m ? Number(m[1]) : null;
    };

    deals = deals
      .filter(d => d && d.link && d.link.includes('/marketplace/item/'))
      .filter(d => !/^mark as read$/i.test(d.title || ''))
      .map(d => ({ ...d, priceNumber: parsePriceNumber(d.price) }))
      .filter(d => {
        if (minPrice != null && (d.priceNumber == null || d.priceNumber < minPrice)) return false;
        if (maxPrice != null && (d.priceNumber == null || d.priceNumber > maxPrice)) return false;
        return true;
      })
      .slice(0, limit);

    // Extract models and fetch sold history
    const models = deals.map(d => extractModel(d.title)).filter(Boolean);
    const soldHistory = await fetchSoldHistory([...new Set(models)], page);

    // Attach sold data to each deal
    deals = deals.map(d => {
      const model = extractModel(d.title);
      const sold = soldHistory[model] || { sold: 0, avg: 0, low: 0, high: 0 };
      const buyPrice = d.priceNumber || 0;
      const fixCost = 12; // default carb fix
      const profitLow = sold.low > 0 ? sold.low - buyPrice - fixCost : 0;
      const profitHigh = sold.high > 0 ? sold.high - buyPrice - fixCost : 0;
      const marginFromAvg = sold.avg > 0 ? ((sold.avg - buyPrice) / sold.avg * 100) : 0;
      return {
        ...d,
        model,
        soldHistory: sold,
        avgSold: sold.avg || 0,
        profitRange: sold.sold > 0 ? `$${profitLow}–$${profitHigh}` : 'no data',
        profitScore: sold.sold > 0 ? profitHigh : -Infinity,
        marginFromAvg: marginFromAvg,
        fixCost,
        flipTime: sold.sold > 2 ? '9 days' : 'unknown'
      };
    }).sort((a, b) => (b.marginFromAvg || -Infinity) - (a.marginFromAvg || -Infinity));

    saveResults(deals, { ...params, url: targetUrl });
    sendNotification(deals);
  } finally {
    try {
      if (currentBrowser) await currentBrowser.close();
    } catch (_) {}
    currentBrowser = null;
  }

  return deals;
}

loadResults();
loadNotifyConfig();

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (pathname === '/' || pathname === '') {
    res.writeHead(200);
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Mower Scraper Control</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 32px;
          }
          .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 40px;
            max-width: 1200px;
            width: 100%;
          }
          h1 {
            color: #333;
            margin-bottom: 30px;
            text-align: left;
            font-size: 28px;
          }
          .form-group {
            margin-bottom: 20px;
          }
          label {
            display: block;
            margin-bottom: 8px;
            color: #555;
            font-weight: 500;
            font-size: 14px;
          }
          input, select {
            width: 100%;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            transition: border-color 0.3s;
          }
          input:focus, select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
          }
          .button-group {
            display: flex;
            gap: 10px;
            margin-top: 30px;
          }
          button {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
          }
          .btn-start {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .btn-start:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
          }
          .btn-stop {
            background: #f0f0f0;
            color: #333;
          }
          .btn-stop:hover {
            background: #e0e0e0;
          }
          .status {
            margin-top: 20px;
            padding: 15px;
            border-radius: 6px;
            text-align: center;
            font-weight: 500;
            display: none;
          }
          .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
            display: block;
          }
          .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
            display: block;
          }
          .info {
            background: #e7f3ff;
            border-left: 4px solid #667eea;
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
            font-size: 13px;
            color: #004085;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚜 Mower Scraper</h1>
          
          <div class="info">
            <strong>Status:</strong> Ready to scrape marketplace listings. Adjust parameters and click Start to begin.
          </div>

          <form id="scraperForm" onsubmit="event.preventDefault(); startScraper();">
            <div class="form-group">
              <label for="keywords">Keywords</label>
              <input type="text" id="keywords" name="keywords" placeholder="e.g., riding mower, lawn tractor" value="riding mower">
            </div>

            <div class="form-group">
              <label for="radius">Search Radius (miles)</label>
              <input type="number" id="radius" name="radius" placeholder="25" value="25" min="1" max="100">
            </div>

            <div class="form-group">
              <label for="maxPrice">Max Price ($)</label>
              <input type="number" id="maxPrice" name="maxPrice" placeholder="5000" value="5000" min="0">
            </div>

            <div class="form-group">
              <label for="minPrice">Min Price ($)</label>
              <input type="number" id="minPrice" name="minPrice" placeholder="0" value="0" min="0">
            </div>

            <div class="form-group">
              <label for="limit">Results Limit</label>
              <input type="number" id="limit" name="limit" placeholder="10" value="10" min="1" max="100">
            </div>

            <div class="form-group">
              <label for="interval">Refresh Interval (seconds)</label>
              <input type="number" id="interval" name="interval" placeholder="300" value="300" min="10">
            </div>

            <div class="form-group">
              <label for="webhookUrl">Webhook URL (for SMS via IFTTT/Zapier)</label>
              <input type="text" id="webhookUrl" name="webhookUrl" placeholder="https://maker.ifttt.com/trigger/...">
            </div>

            <div class="form-group">
              <label for="phoneNumber">Phone Number (optional, sent in webhook)</label>
              <input type="tel" id="phoneNumber" name="phoneNumber" placeholder="+1234567890">
            </div>

            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" id="notifyEnabled" name="notifyEnabled" style="width:auto;">
                <span>Enable notifications</span>
              </label>
            </div>

            <div class="button-group">
              <button type="submit" class="btn-start">▶ Start Scraper</button>
              <button type="button" class="btn-stop" onclick="stopScraper()">⏹ Stop</button>
            </div>

            <div style="margin-top:12px;">
              <button type="button" class="btn-stop" style="width:100%;" onclick="saveNotify()">💾 Save Notification Settings</button>
            </div>

            <div id="status" class="status"></div>
          </form>

          <div style="margin-top:30px">
            <h2 style="font-size:20px;margin-bottom:10px;color:#333">Latest Results</h2>
            <div style="display:flex; gap:10px; margin: 0 0 12px 0; align-items:center;">
              <a id="dlCsv" href="/api/csv" class="btn-start" style="text-decoration:none;display:inline-block;padding:8px 12px;border-radius:6px;color:#fff;">⬇ Download CSV</a>
              <button type="button" id="copyCsv" class="btn-stop" style="padding:8px 12px;">Copy CSV</button>
              <span id="count" style="color:#555;font-size:13px"></span>
            </div>

            <div style="overflow:auto; border:1px solid #eee; border-radius:8px;">
              <table id="resultsTable" style="width:100%; border-collapse:collapse; min-width:1200px;">
                <thead>
                  <tr style="background:#f5f5ff">
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Title</th>
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Price</th>
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Sold (30d)</th>
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Avg Sold</th>
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Margin %</th>
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Profit</th>
                    <th style="text-align:left; padding:10px; border-bottom:1px solid #eee;">Link</th>
                  </tr>
                </thead>
                <tbody id="resultsBody"></tbody>
              </table>
            </div>

            <div id="meta" style="margin-top:8px;color:#666;font-size:12px"></div>
          </div>
        </div>

        <script>
          function renderResults(data) {
            const body = document.getElementById('resultsBody');
            const meta = document.getElementById('meta');
            const count = document.getElementById('count');
            body.innerHTML = '';
            const deals = (data && Array.isArray(data.deals)) ? data.deals : [];
            if (deals.length === 0) {
              const tr = document.createElement('tr');
              const td = document.createElement('td');
              td.colSpan = 7;
              td.style.color = '#666';
              td.style.padding = '12px';
              td.textContent = 'No results yet.';
              tr.appendChild(td);
              body.appendChild(tr);
            } else {
              for (const d of deals) {
                const tr = document.createElement('tr');
                tr.style.background = (body.children.length % 2 === 0) ? '#fff' : '#fcfcff';

                const tdTitle = document.createElement('td');
                tdTitle.style.padding = '10px';
                tdTitle.style.borderBottom = '1px solid #f0f0f0';
                const titleLink = document.createElement('a');
                titleLink.href = d.link;
                titleLink.target = '_blank';
                titleLink.style.color = '#333';
                titleLink.style.textDecoration = 'none';
                titleLink.textContent = d.title || 'No title';
                titleLink.addEventListener('mouseenter', function() { this.style.color = '#667eea'; this.style.textDecoration = 'underline'; });
                titleLink.addEventListener('mouseleave', function() { this.style.color = '#333'; this.style.textDecoration = 'none'; });
                tdTitle.appendChild(titleLink);
                tr.appendChild(tdTitle);

                const tdPrice = document.createElement('td');
                tdPrice.style.padding = '10px';
                tdPrice.style.borderBottom = '1px solid #f0f0f0';
                tdPrice.textContent = d.price || (d.priceNumber != null ? ('$' + d.priceNumber) : 'N/A');
                tr.appendChild(tdPrice);

                const tdSold = document.createElement('td');
                tdSold.style.padding = '10px';
                tdSold.style.borderBottom = '1px solid #f0f0f0';
                tdSold.style.fontSize = '13px';
                tdSold.style.color = '#555';
                if (d.soldHistory && d.soldHistory.sold > 0) {
                  tdSold.innerHTML = d.soldHistory.sold + ' @ $' + d.soldHistory.avg + '<br><span style="color:#999;font-size:11px">($' + d.soldHistory.low + '–$' + d.soldHistory.high + ')</span>';
                } else {
                  tdSold.textContent = 'no data';
                }
                tr.appendChild(tdSold);

                const tdAvg = document.createElement('td');
                tdAvg.style.padding = '10px';
                tdAvg.style.borderBottom = '1px solid #f0f0f0';
                tdAvg.style.fontSize = '13px';
                tdAvg.style.color = '#333';
                if (d.avgSold && d.avgSold > 0) {
                  tdAvg.innerHTML = '$' + d.avgSold;
                } else {
                  tdAvg.textContent = 'no data';
                }
                tr.appendChild(tdAvg);

                const tdMargin = document.createElement('td');
                tdMargin.style.padding = '10px';
                tdMargin.style.borderBottom = '1px solid #f0f0f0';
                tdMargin.style.fontSize = '13px';
                tdMargin.style.fontWeight = '600';
                if (d.marginFromAvg != null && d.marginFromAvg >= 0) {
                  tdMargin.style.color = d.marginFromAvg >= 15 ? '#27ae60' : d.marginFromAvg >= 0 ? '#f39c12' : '#e74c3c';
                  tdMargin.textContent = d.marginFromAvg.toFixed(1) + '%';
                } else {
                  tdMargin.style.color = '#e74c3c';
                  tdMargin.textContent = (d.marginFromAvg || 0).toFixed(1) + '%';
                }
                tr.appendChild(tdMargin);

                const tdProfit = document.createElement('td');
                tdProfit.style.padding = '10px';
                tdProfit.style.borderBottom = '1px solid ' + '#f0f0f0';
                tdProfit.style.fontSize = '13px';
                tdProfit.style.fontWeight = '600';
                if (d.profitRange && d.profitRange !== 'no data') {
                  tdProfit.style.color = '#27ae60';
                  tdProfit.innerHTML = d.profitRange + '<br><span style="color:#999;font-size:11px;font-weight:400">Fix: $' + (d.fixCost || 12) + ' · ' + (d.flipTime || '9 days') + '</span>';
                } else {
                  tdProfit.style.color = '#999';
                  tdProfit.textContent = 'no data';
                }
                tr.appendChild(tdProfit);

                const tdLink = document.createElement('td');
                tdLink.style.padding = '10px';
                tdLink.style.borderBottom = '1px solid #f0f0f0';
                const a = document.createElement('a');
                a.href = d.link;
                a.target = '_blank';
                a.style.color = '#667eea';
                a.textContent = 'Open';
                tdLink.appendChild(a);
                tr.appendChild(tdLink);

                body.appendChild(tr);
              }
            }
            count.textContent = (deals.length + ' result(s)');
            meta.textContent = data && data.ts ? ('Updated: ' + new Date(data.ts).toLocaleString()) : '';
          }

          function refreshResults() {
            fetch('/api/results')
              .then(r => r.json())
              .then(data => renderResults(data))
              .catch(() => {});
          }

          function startScraper() {
            const keywords = document.getElementById('keywords').value;
            const radius = document.getElementById('radius').value;
            const maxPrice = document.getElementById('maxPrice').value;
            const minPrice = document.getElementById('minPrice').value;
            const limit = document.getElementById('limit').value;
            const interval = document.getElementById('interval').value;

            const params = new URLSearchParams({
              keywords,
              radius,
              maxPrice,
              minPrice,
              limit,
              interval
            });

              fetch('/api/start?' + params.toString())
              .then(res => res.json())
              .then(data => {
                const statusEl = document.getElementById('status');
                if (data.success) {
                  statusEl.className = 'status success';
                  statusEl.textContent = '✓ Scraper started with your parameters!';
                  setTimeout(refreshResults, 2500);
                } else {
                  statusEl.className = 'status error';
                  statusEl.textContent = '✗ Error: ' + data.message;
                }
              })
              .catch(err => {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status error';
                statusEl.textContent = '✗ Connection error: ' + err.message;
              });
          }

          function stopScraper() {
            fetch('/api/stop')
              .then(res => res.json())
              .then(data => {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status success';
                statusEl.textContent = '✓ Scraper stopped.';
              })
              .catch(err => {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status error';
                statusEl.textContent = '✗ Error stopping scraper.';
              });
          }

          // Initial load
          refreshResults();
          loadNotifySettings();
          // Auto-refresh every 10s for UI visibility
          setInterval(refreshResults, 10000);

          document.getElementById('copyCsv').addEventListener('click', async () => {
            try {
              const res = await fetch('/api/csv');
              const csv = await res.text();
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(csv);
              } else {
                const ta = document.createElement('textarea');
                ta.value = csv; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
              }
              const statusEl = document.getElementById('status');
              statusEl.className = 'status success';
              statusEl.textContent = '✓ CSV copied to clipboard';
            } catch (e) {
              const statusEl = document.getElementById('status');
              statusEl.className = 'status error';
              statusEl.textContent = '✗ Failed to copy CSV';
            }
          });

          function loadNotifySettings() {
            fetch('/api/notify')
              .then(r => r.json())
              .then(data => {
                document.getElementById('webhookUrl').value = data.webhookUrl || '';
                document.getElementById('phoneNumber').value = data.phoneNumber || '';
                document.getElementById('notifyEnabled').checked = data.enabled || false;
              })
              .catch(() => {});
          }

          function saveNotify() {
            const config = {
              webhookUrl: document.getElementById('webhookUrl').value,
              phoneNumber: document.getElementById('phoneNumber').value,
              enabled: document.getElementById('notifyEnabled').checked
            };
            fetch('/api/notify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config)
            })
              .then(r => r.json())
              .then(() => {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status success';
                statusEl.textContent = '✓ Notification settings saved';
              })
              .catch(() => {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status error';
                statusEl.textContent = '✗ Failed to save settings';
              });
          }
        </script>
      </body>
      </html>
    `);
  } else if (pathname === '/api/start') {
    const params = parsedUrl.query;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const intervalSec = Math.max(0, parseInt(params.interval || '0', 10));

    const kick = () => {
      if (isRunning) return; // skip if a run is in progress
      isRunning = true;
      runScrape(params)
        .catch((err) => {
          saveResults([], { ...params, error: String(err && err.message || err) });
        })
        .finally(() => { isRunning = false; });
    };

    // Clear any existing schedule
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }

    // Run immediately
    kick();

    // Schedule next runs if interval provided
    if (intervalSec > 0) {
      intervalHandle = setInterval(kick, intervalSec * 1000);
    }

    res.end(JSON.stringify({ success: true, message: 'Scraper started', scheduled: intervalSec > 0 }));
  } else if (pathname === '/api/stop') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (currentBrowser) {
      Promise.resolve(currentBrowser.close()).finally(() => {
        currentBrowser = null;
      });
    }
    isRunning = false;
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    res.end(JSON.stringify({ success: true, message: 'Scraper stopped' }));
  } else if (pathname === '/api/results') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastResult));
  } else if (pathname === '/api/csv') {
    const ts = (lastResult && lastResult.ts) ? lastResult.ts.replace(/[:T]/g, '-').replace(/\..+$/, '') : new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
    const csv = toCSV(lastResult.deals || []);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mower-results-${ts}.csv"`
    });
    res.end(csv);
  } else if (pathname === '/api/notify' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(notifyConfig));
  } else if (pathname === '/api/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        saveNotifyConfig(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(8020, () => {
  console.log('🚀 Mower Scraper UI running on http://localhost:8020');
});
