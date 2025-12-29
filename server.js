const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// Human-like behavior helpers to avoid bot detection
const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const randomUserAgent = () => {
  const agents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ];
  return agents[randomInt(0, agents.length - 1)];
};

// Add human-like mouse movements
async function humanMouseMovement(page) {
  const movements = randomInt(3, 8);
  for (let i = 0; i < movements; i++) {
    const x = randomInt(100, 1000);
    const y = randomInt(100, 600);
    await page.mouse.move(x, y);
    await randomDelay(100, 300);
  }
}

// Human-like scrolling with random patterns
async function humanScroll(page, maxScrolls) {
  const scrollCount = randomInt(Math.floor(maxScrolls * 0.7), maxScrolls);
  for (let i = 0; i < scrollCount; i++) {
    const scrollAmount = randomInt(300, 800);
    await page.evaluate((amount) => {
      window.scrollBy(0, amount);
    }, scrollAmount);
    await randomDelay(500, 1500);

    // Sometimes scroll back up a bit (realistic browsing)
    if (Math.random() < 0.2) {
      await page.evaluate(() => window.scrollBy(0, -200));
      await randomDelay(300, 700);
    }
  }
}

// Puppeteer config for production (Fly.io) vs local
// forLogin = true shows browser (for "forgot password" flows), false hides it (for scraping)
function getPuppeteerConfig(forLogin = false) {
  const isProduction = process.env.PORT === '8080' || process.env.FLY_APP_NAME;

  // Base config with user data directory for persistent sessions (keeps Facebook login)
  const baseConfig = {
    userDataDir: path.join(getUserDataDir(), 'browser-data'),
    headless: forLogin ? false : 'new'  // Visible for login, new headless mode for scraping
  };

  if (isProduction) {
    return {
      ...baseConfig,
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    };
  }

  // Local desktop app
  return baseConfig;
}

// Get user-specific data directory
// Each user gets their own isolated storage in their system's Application Support folder
function getUserDataDir() {
  const os = require('os');
  const homeDir = os.homedir();

  // macOS: ~/Library/Application Support/Marketplace Finder
  // Windows: C:\Users\[username]\AppData\Roaming\Marketplace Finder
  // Linux: ~/.local/share/Marketplace Finder
  let dataDir;
  if (process.platform === 'darwin') {
    dataDir = path.join(homeDir, 'Library', 'Application Support', 'Marketplace Finder');
  } else if (process.platform === 'win32') {
    dataDir = path.join(homeDir, 'AppData', 'Roaming', 'Marketplace Finder');
  } else {
    dataDir = path.join(homeDir, '.local', 'share', 'Marketplace Finder');
  }

  // Create directory if it doesn't exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`Created user data directory: ${dataDir}`);
  }

  return dataDir;
}

// In-memory state
let isRunning = false;
let currentBrowser = null;
let lastResult = { deals: [], params: null, ts: null };
const USER_DATA_DIR = getUserDataDir();
const RESULTS_PATH = path.join(USER_DATA_DIR, 'results.json');
const NOTIFY_CONFIG_PATH = path.join(USER_DATA_DIR, 'notify-config.json');
let intervalHandle = null;
let notifyConfig = { webhookUrl: '', phoneNumber: '', enabled: false };

function toCSV(rows) {
  const headers = ['title', 'price', 'priceNumber', 'model', 'soldLast30', 'avgSold', 'marginFromAvg', 'profitRange', 'link', 'description'];
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
      r.link || '',
      r.description || ''
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
  const message = `Found ${deals.length} listing(s): ${deals.slice(0, 3).map(d => d.title + ' - ' + d.price).join(', ')}`;
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

async function fetchSoldHistory(models, page, coords, radius) {
  const results = {};
  for (const model of models) {
    if (!model) continue;
    try {
      // Try Facebook Marketplace sold search with specified location
      const searchUrl = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(model)}&exact=false&latitude=${coords.lat}&longitude=${coords.lng}&radius=${radius}`;
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
  const emitProgress = (stage, progress, message) => {
    if (global.progressClients) {
      global.progressClients.forEach(client => {
        try {
          client(stage, progress, message);
        } catch (e) {
          // Client disconnected
        }
      });
    }
  };

  const limit = Math.max(1, Math.min(100, parseInt(params.limit || '10', 10)));
  const keywords = (params.keywords || '').trim();
  const location = (params.location || '37138').trim(); // Default to Nashville zip
  const radius = parseInt(params.radius || '50', 10);

  // Geocode location to coordinates (using hardcoded values for common locations)
  const locationMap = {
    // Tennessee
    '37138': { lat: 36.1627, lng: -86.7816, name: 'Nashville, TN' },
    'nashville': { lat: 36.1627, lng: -86.7816, name: 'Nashville, TN' },
    'memphis': { lat: 35.1495, lng: -90.0490, name: 'Memphis, TN' },
    'knoxville': { lat: 35.9606, lng: -83.9207, name: 'Knoxville, TN' },
    // California
    '90210': { lat: 34.0901, lng: -118.4065, name: 'Beverly Hills, CA' },
    'losangeles': { lat: 34.0522, lng: -118.2437, name: 'Los Angeles, CA' },
    'sandiego': { lat: 32.7157, lng: -117.1611, name: 'San Diego, CA' },
    'sanfrancisco': { lat: 37.7749, lng: -122.4194, name: 'San Francisco, CA' },
    'sacramento': { lat: 38.5816, lng: -121.4944, name: 'Sacramento, CA' },
    // Other major cities
    'newyork': { lat: 40.7128, lng: -74.0060, name: 'New York, NY' },
    'chicago': { lat: 41.8781, lng: -87.6298, name: 'Chicago, IL' },
    'houston': { lat: 29.7604, lng: -95.3698, name: 'Houston, TX' },
    'dallas': { lat: 32.7767, lng: -96.7970, name: 'Dallas, TX' },
    'austin': { lat: 30.2672, lng: -97.7431, name: 'Austin, TX' },
    'phoenix': { lat: 33.4484, lng: -112.0740, name: 'Phoenix, AZ' },
    'philadelphia': { lat: 39.9526, lng: -75.1652, name: 'Philadelphia, PA' },
    'atlanta': { lat: 33.7490, lng: -84.3880, name: 'Atlanta, GA' },
    'miami': { lat: 25.7617, lng: -80.1918, name: 'Miami, FL' },
    'seattle': { lat: 47.6062, lng: -122.3321, name: 'Seattle, WA' },
    'boston': { lat: 42.3601, lng: -71.0589, name: 'Boston, MA' },
    'denver': { lat: 39.7392, lng: -104.9903, name: 'Denver, CO' }
  };

  const coords = locationMap[location.toLowerCase()] || { lat: 36.1627, lng: -86.7816, name: location };
  console.log(`Using location: ${coords.name} (${coords.lat}, ${coords.lng})`);

  const baseUrl = 'https://www.facebook.com/marketplace';
  const titleKeywords = (params.titleKeywords || '').trim();
  const descriptionKeywords = (params.descriptionKeywords || '').trim();

  // Build search URL: use keywords if provided, otherwise search all categories
  const targetUrl = keywords
    ? `${baseUrl}/search/?query=${encodeURIComponent(keywords)}&latitude=${coords.lat}&longitude=${coords.lng}&radius=${radius}`
    : `${baseUrl}/?latitude=${coords.lat}&longitude=${coords.lng}&radius=${radius}`;
  console.log('Target URL:', targetUrl); // Debug logging
  const minPrice = isFinite(Number(params.minPrice)) ? Number(params.minPrice) : null;
  const maxPrice = isFinite(Number(params.maxPrice)) ? Number(params.maxPrice) : null;

  let deals = [];
  try {
    emitProgress('starting', 0, 'Launching browser...');
    currentBrowser = await puppeteer.launch(getPuppeteerConfig());
    const page = await currentBrowser.newPage();

    // Set random user agent to look more like a real browser (avoid bot detection)
    await page.setUserAgent(randomUserAgent());

    // Set viewport with slight randomization
    await page.setViewport({
      width: randomInt(1200, 1400),
      height: randomInt(700, 900)
    });

    // Random initial delay before loading (simulates human opening browser)
    await randomDelay(1000, 3000);

    // CRITICAL: Override geolocation to match our target location
    const context = currentBrowser.defaultBrowserContext();
    await context.overridePermissions('https://www.facebook.com', ['geolocation']);
    await page.setGeolocation({
      latitude: coords.lat,
      longitude: coords.lng,
      accuracy: 100
    });
    console.log(`Geolocation set to: ${coords.lat}, ${coords.lng}`);

    // Apply cookies from cookies.json
    try {
      const cookies = JSON.parse(fs.readFileSync(path.join(__dirname, 'cookies.json'), 'utf8'));
      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
        console.log(`Loaded ${cookies.length} cookies from cookies.json`);
      }
    } catch (err) {
      console.log('No cookies found, will need manual login');
    }

    emitProgress('loading', 10, `Loading marketplace page for ${coords.name}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

    // Random delay after page load (human-like behavior)
    await randomDelay(2000, 4000);

    // Human-like mouse movements
    await humanMouseMovement(page);

    // Check if we're on a login page
    const isLoginPage = await page.evaluate(() => {
      return !!(document.querySelector('input[type="password"]') ||
                document.querySelector('input[name="email"]') ||
                window.location.href.includes('login'));
    });

    if (isLoginPage) {
      console.error('Still on login page - cookies may be invalid or expired');
      throw new Error('Login required - please click "🔐 Login to Facebook First" button and log in before starting the scraper');
    }

    // Wait for page to load and verify location
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Debug: Check what location Facebook detected
    try {
      const detectedLocation = await page.evaluate(() => {
        // Try to find location info on the page
        const locationElements = document.querySelectorAll('[data-testid*="location"], [aria-label*="location"], .location');
        for (const el of locationElements) {
          if (el.textContent && el.textContent.length > 3) {
            return el.textContent.trim();
          }
        }
        return 'checking...';
      });
      console.log('Facebook detected location:', detectedLocation);
      emitProgress('loading', 15, `Loading marketplace (Location: ${detectedLocation})...`);
    } catch (e) {
      console.log('Could not detect location:', e.message);
      emitProgress('loading', 15, `Loading marketplace for ${coords.name}...`);
    }

    emitProgress('scrolling', 20, 'Loading more listings...');
    // Wait for listings to appear
    try {
      await page.waitForSelector('a[href*="/marketplace/item/"]', { timeout: 10000 });
    } catch (e) {
      console.log('No listings found or page not loaded');
    }

    // Use human-like scrolling pattern to avoid bot detection
    try {
      await humanScroll(page, 12);
      // Additional random delay after scrolling
      await randomDelay(1000, 2000);
    } catch (_) {}

    emitProgress('extracting', 30, 'Extracting listing data...');
    // Wait a moment for page to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
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
    } catch (err) {
      console.error('Error extracting deals:', err.message);
      // If frame detached, reload and try again
      if (err.message.includes('detached')) {
        console.log('Frame detached, reloading page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
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
      } else {
        throw err;
      }
    }

    emitProgress('filtering', 70, 'Filtering results...');
    // Filter based on title and description keywords
    if (titleKeywords) {
      const titleKeys = titleKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
      if (titleKeys.length > 0) {
        deals = deals.filter(d => {
          const title = (d.title || '').toLowerCase();
          return titleKeys.some(key => title.includes(key));
        });
      }
    }
    if (descriptionKeywords) {
      const descKeys = descriptionKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
      if (descKeys.length > 0) {
        deals = deals.filter(d => {
          const desc = (d.description || '').toLowerCase();
          return descKeys.some(key => desc.includes(key));
        });
      }
    }

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
      .slice(0, limit)
      .sort((a, b) => (a.priceNumber || 0) - (b.priceNumber || 0)); // Sort by price (lowest first)

    emitProgress('saving', 95, 'Saving results...');
    saveResults(deals, { ...params, url: targetUrl });
    sendNotification(deals);
    
    emitProgress('complete', 100, `Completed! Found ${deals.length} deals`);
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
        <title>Marketplace Finder - Hunt for Deals</title>
        <style>
          @keyframes gradient {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(-45deg, #ee7752, #e73c7e, #23a6d5, #23d5ab);
            background-size: 400% 400%;
            animation: gradient 15s ease infinite;
            min-height: 100vh;
            padding: 20px;
          }
          .container {
            max-width: 1400px;
            margin: 0 auto;
            animation: fadeIn 0.6s ease;
          }
          .header {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 32px 40px;
            margin-bottom: 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.3);
          }
          h1 {
            font-size: 42px;
            font-weight: 800;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .tagline {
            font-size: 16px;
            color: #666;
            font-weight: 500;
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            margin-top: 16px;
          }
          .status-dot {
            width: 8px;
            height: 8px;
            background: white;
            border-radius: 50%;
            animation: pulse 2s ease-in-out infinite;
          }
          .cards-container {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
          }
          @media (max-width: 968px) {
            .cards-container {
              grid-template-columns: 1fr;
            }
          }
          .card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 28px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.3);
          }
          .card-title {
            font-size: 18px;
            font-weight: 700;
            color: #333;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .card-icon {
            font-size: 24px;
          }
          .form-group {
            margin-bottom: 18px;
          }
          label {
            display: block;
            margin-bottom: 8px;
            color: #444;
            font-weight: 600;
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          input, select {
            width: 100%;
            padding: 14px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            font-size: 15px;
            transition: all 0.3s ease;
            background: white;
          }
          input:focus, select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
            transform: translateY(-2px);
          }
          input::placeholder {
            color: #aaa;
          }
          .button-group {
            display: flex;
            gap: 12px;
          }
          button {
            flex: 1;
            padding: 16px 24px;
            border: none;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .btn-start {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
          }
          .btn-start:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
          }
          .btn-start:active {
            transform: translateY(-1px);
          }
          .btn-stop {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(245, 87, 108, 0.4);
          }
          .btn-stop:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 20px rgba(245, 87, 108, 0.5);
          }
          .btn-secondary {
            background: white;
            color: #333;
            border: 2px solid #e0e0e0;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          }
          .btn-secondary:hover {
            background: #f8f8f8;
            border-color: #667eea;
            transform: translateY(-2px);
          }
          .btn-login {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: white;
            padding: 16px 24px;
            border-radius: 12px;
            border: none;
            cursor: pointer;
            font-weight: 700;
            font-size: 15px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            box-shadow: 0 4px 15px rgba(17, 153, 142, 0.4);
            transition: all 0.3s ease;
          }
          .btn-login:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 20px rgba(17, 153, 142, 0.5);
          }
          .status {
            margin-top: 20px;
            padding: 16px 20px;
            border-radius: 12px;
            font-weight: 600;
            display: none;
            border-left: 4px solid;
          }
          .status.success {
            background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
            color: #155724;
            border-color: #28a745;
            display: block;
          }
          .status.error {
            background: linear-gradient(135deg, #f8d7da 0%, #f5c6cb 100%);
            color: #721c24;
            border-color: #dc3545;
            display: block;
          }
          .info-box {
            background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%);
            border-left: 4px solid #00acc1;
            padding: 16px 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            font-size: 14px;
            color: #00838f;
            line-height: 1.6;
          }
          .results-card {
            grid-column: 1 / -1;
          }
          .results-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 12px;
          }
          .results-actions {
            display: flex;
            gap: 10px;
            align-items: center;
          }
          .count-badge {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 12px;
            overflow: hidden;
          }
          th {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: left;
            padding: 16px;
            font-weight: 600;
            text-transform: uppercase;
            font-size: 12px;
            letter-spacing: 0.5px;
          }
          td {
            padding: 14px 16px;
            border-bottom: 1px solid #f0f0f0;
            color: #333;
          }
          tr:hover {
            background: #f8f9ff;
          }
          td a {
            color: #667eea;
            text-decoration: none;
            font-weight: 500;
          }
          td a:hover {
            text-decoration: underline;
          }
          .required {
            color: #e74c3c;
            margin-left: 4px;
            font-weight: 700;
          }
          th .required {
            color: #fff;
            text-shadow: 0 0 3px rgba(231, 76, 60, 0.8);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Header -->
          <div class="header">
            <h1>🛍️ Marketplace Finder</h1>
            <div class="tagline">Hunt for the best deals on Facebook Marketplace</div>
            <div class="status-badge">
              <div class="status-dot"></div>
              Ready to Hunt
            </div>
          </div>

          <!-- Cards Grid -->
          <div class="cards-container">
            <!-- Authentication Card -->
            <div class="card">
              <div class="card-title">
                <span class="card-icon">🔐</span>
                Authentication
              </div>
              <div class="info-box">
                <strong>First Step:</strong> Log into Facebook before starting the scraper
              </div>
              <button type="button" onclick="simpleLogin()" class="btn-login">
                Login to Facebook
              </button>
              <div id="loginStatus" style="margin-top:12px;color:#666;font-size:13px;font-weight:600"></div>
            </div>

            <!-- Search Parameters Card -->
            <div class="card">
              <div class="card-title">
                <span class="card-icon">🔍</span>
                Search Settings
              </div>
              <form id="scraperForm" onsubmit="event.preventDefault(); startScraper();">
                <div class="form-group">
                  <label for="keywords">What are you looking for?</label>
                  <input type="text" id="keywords" name="keywords" placeholder="e.g., furniture, electronics, mowers" value="">
                </div>

                <div class="form-group">
                  <label for="location">Location</label>
                  <input type="text" id="location" name="location" placeholder="Default: 37138 (Nashville, TN)">
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
                  <div class="form-group" style="margin-bottom:0;">
                    <label for="radius">Radius (miles)</label>
                    <input type="number" id="radius" name="radius" placeholder="25" value="25" min="1" max="100">
                  </div>
                  <div class="form-group" style="margin-bottom:0;">
                    <label for="limit">Max Results</label>
                    <input type="number" id="limit" name="limit" placeholder="10" value="10" min="1" max="100">
                  </div>
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:18px;">
                  <div class="form-group" style="margin-bottom:0;">
                    <label for="minPrice">Min Price ($)</label>
                    <input type="number" id="minPrice" name="minPrice" placeholder="0" value="0" min="0">
                  </div>
                  <div class="form-group" style="margin-bottom:0;">
                    <label for="maxPrice">Max Price ($)</label>
                    <input type="number" id="maxPrice" name="maxPrice" placeholder="5000" value="5000" min="0">
                  </div>
                </div>
              </form>
            </div>

            <!-- Advanced Filters Card -->
            <div class="card">
              <div class="card-title">
                <span class="card-icon">🎯</span>
                Advanced Filters
              </div>
              <div class="form-group">
                <label for="titleKeywords">Title Keywords (optional)</label>
                <input type="text" id="titleKeywords" name="titleKeywords" placeholder="e.g., john deere, brand new">
              </div>

              <div class="form-group">
                <label for="descriptionKeywords">Description Keywords (optional)</label>
                <input type="text" id="descriptionKeywords" name="descriptionKeywords" placeholder="e.g., excellent condition, barely used">
              </div>

              <div class="form-group">
                <label for="interval">Auto-Refresh Interval (seconds)</label>
                <input type="number" id="interval" name="interval" placeholder="300" value="300" min="10">
              </div>
            </div>

            <!-- Notifications Card -->
            <div class="card">
              <div class="card-title">
                <span class="card-icon">📱</span>
                Notifications
              </div>
              <div class="form-group">
                <label for="webhookUrl">Webhook URL (IFTTT/Zapier)</label>
                <input type="text" id="webhookUrl" name="webhookUrl" placeholder="https://maker.ifttt.com/trigger/...">
              </div>

              <div class="form-group">
                <label for="phoneNumber">Phone Number</label>
                <input type="tel" id="phoneNumber" name="phoneNumber" placeholder="+1234567890">
              </div>

              <div class="form-group" style="margin-bottom:0;">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;text-transform:none;">
                  <input type="checkbox" id="notifyEnabled" name="notifyEnabled" style="width:20px;height:20px;cursor:pointer;">
                  <span>Enable notifications for new deals</span>
                </label>
              </div>
            </div>

            <!-- Control Panel Card -->
            <div class="card" style="grid-column: 1 / -1;">
              <div class="card-title">
                <span class="card-icon">🎮</span>
                Control Panel
              </div>
              <div class="button-group">
                <button type="submit" class="btn-start" onclick="event.preventDefault(); startScraper();">
                  ▶️ Start Hunting
                </button>
                <button type="button" class="btn-stop" onclick="stopScraper()">
                  ⏹️ Stop
                </button>
                <button type="button" class="btn-secondary" onclick="saveNotify()">
                  💾 Save Settings
                </button>
              </div>
              <div id="status" class="status"></div>
            </div>

            <!-- Results Card -->
            <div class="card results-card">
              <div class="results-header">
                <div class="card-title" style="margin-bottom:0;">
                  <span class="card-icon">💎</span>
                  Latest Finds
                </div>
                <div class="results-actions">
                  <span id="count" class="count-badge">0 deals found</span>
                  <a id="dlCsv" href="/api/csv" class="btn-secondary" style="text-decoration:none;display:inline-block;padding:10px 18px;border-radius:10px;color:#333;font-size:13px;">
                    ⬇️ Download CSV
                  </a>
                  <button type="button" id="copyCsv" class="btn-secondary" style="padding:10px 18px;font-size:13px;">
                    📋 Copy CSV
                  </button>
                </div>
              </div>

              <div style="overflow:auto; border-radius:12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <table id="resultsTable">
                  <thead>
                    <tr>
                      <th>Title <span class="required">*</span></th>
                      <th>Price</th>
                      <th>Link</th>
                    </tr>
                  </thead>
                  <tbody id="resultsBody"></tbody>
                </table>
              </div>

              <div id="meta" style="margin-top:12px;color:#888;font-size:12px;font-weight:500"></div>
            </div>
          </div>
        </div>

        <script>
          function renderResults(data) {
            const body = document.getElementById('resultsBody');
            const meta = document.getElementById('meta');
            const count = document.getElementById('count');
            body.innerHTML = '';
            const deals = (data && Array.isArray(data.deals)) ? data.deals : [];

            // Update count badge
            count.textContent = deals.length === 1 ? '1 deal found' : deals.length + ' deals found';

            if (deals.length === 0) {
              const tr = document.createElement('tr');
              const td = document.createElement('td');
              td.colSpan = 8;
              td.style.color = '#999';
              td.style.padding = '40px 20px';
              td.style.textAlign = 'center';
              td.style.fontSize = '16px';
              td.innerHTML = '🔍 No deals found yet. Start hunting to see results!';
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
                titleLink.href = '#';
                titleLink.style.color = '#333';
                titleLink.style.textDecoration = 'none';
                titleLink.style.cursor = 'pointer';
                titleLink.textContent = d.title || 'No title';
                titleLink.addEventListener('click', function(e) {
                  e.preventDefault();
                  // Open in new window/tab
                  const newWindow = window.open(d.link, '_blank', 'noopener,noreferrer');
                  if (!newWindow) {
                    // Fallback: navigate in same window
                    window.location.href = d.link;
                  }
                });
                titleLink.addEventListener('mouseenter', function() { this.style.color = '#667eea'; this.style.textDecoration = 'underline'; });
                titleLink.addEventListener('mouseleave', function() { this.style.color = '#333'; this.style.textDecoration = 'none'; });
                tdTitle.appendChild(titleLink);

                const tdPrice = document.createElement('td');
                tdPrice.style.padding = '10px';
                tdPrice.style.borderBottom = '1px solid #f0f0f0';
                tdPrice.style.fontSize = '14px';
                tdPrice.style.fontWeight = '600';
                tdPrice.style.color = '#27ae60';
                tdPrice.textContent = d.price || (d.priceNumber != null ? ('$' + d.priceNumber) : 'N/A');

                // Append in order: Title, Price, Link
                tr.appendChild(tdTitle);
                tr.appendChild(tdPrice);

                const tdLink = document.createElement('td');
                tdLink.style.padding = '10px';
                tdLink.style.borderBottom = '1px solid #f0f0f0';
                const a = document.createElement('a');
                a.href = '#';
                a.style.color = '#667eea';
                a.style.cursor = 'pointer';
                a.style.textDecoration = 'none';
                a.textContent = 'Open';
                a.addEventListener('click', function(e) {
                  e.preventDefault();
                  // Open in new window/tab
                  const newWindow = window.open(d.link, '_blank', 'noopener,noreferrer');
                  if (!newWindow) {
                    // Fallback: navigate in same window
                    window.location.href = d.link;
                  }
                });
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
            const location = document.getElementById('location').value;
            const radius = document.getElementById('radius').value;
            const maxPrice = document.getElementById('maxPrice').value;
            const minPrice = document.getElementById('minPrice').value;
            const limit = document.getElementById('limit').value;
            const interval = document.getElementById('interval').value;
            const titleKeywords = document.getElementById('titleKeywords').value;
            const descriptionKeywords = document.getElementById('descriptionKeywords').value;

            const params = new URLSearchParams({
              keywords,
              location,
              radius,
              maxPrice,
              minPrice,
              limit,
              interval,
              titleKeywords,
              descriptionKeywords
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

          async function simpleLogin() {
            const statusEl = document.getElementById('loginStatus');
            statusEl.textContent = 'Opening Facebook...';
            statusEl.style.color = '#666';

            try {
              const response = await fetch('/api/simple-login', { method: 'POST' });
              const data = await response.json();

              if (data.success) {
                statusEl.style.color = '#28a745';
                statusEl.textContent = '✓ Login complete! You can now start the scraper.';
              } else {
                statusEl.style.color = '#dc3545';
                statusEl.textContent = '✗ ' + (data.error || 'Login failed');
              }
            } catch (err) {
              statusEl.style.color = '#dc3545';
              statusEl.textContent = '✗ Error: ' + err.message;
            }
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
          console.error('Scraper error:', err);
          const errorMsg = err && err.message ? err.message : String(err);
          saveResults([], { ...params, error: errorMsg, errorStack: err.stack });
        })
        .finally(() => {
          isRunning = false;

          // Schedule next run with randomized delay to avoid bot detection
          if (intervalSec > 0 && intervalHandle !== null) {
            // Randomize interval: base interval ±20% (e.g., 5min becomes 4-6min)
            const minDelay = intervalSec * 0.8;
            const maxDelay = intervalSec * 1.2;
            const randomizedDelay = Math.floor(Math.random() * (maxDelay - minDelay) + minDelay) * 1000;
            console.log(`Next scrape in ${Math.floor(randomizedDelay / 1000 / 60)} minutes ${Math.floor((randomizedDelay / 1000) % 60)} seconds`);
            intervalHandle = setTimeout(kick, randomizedDelay);
          }
        });
    };

    // Clear any existing schedule
    if (intervalHandle) {
      clearTimeout(intervalHandle);
      intervalHandle = null;
    }

    // Run immediately
    kick();

    // Set intervalHandle to a non-null value to indicate scheduling is active
    if (intervalSec > 0) {
      intervalHandle = true; // Will be replaced by setTimeout after first run
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
    if (intervalHandle) {
      if (typeof intervalHandle === 'object') {
        clearTimeout(intervalHandle);
      }
      intervalHandle = null;
    }
    res.end(JSON.stringify({ success: true, message: 'Scraper stopped' }));
  } else if (pathname === '/api/results') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastResult));
  } else if (pathname === '/api/csv') {
    const ts = (lastResult && lastResult.ts) ? lastResult.ts.replace(/[:T]/g, '-').replace(/\..+$/, '') : new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
    const csv = toCSV(lastResult.deals || []);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="marketplace-results-${ts}.csv"`
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
  } else if (pathname === '/api/capture-cookies' && req.method === 'POST') {
    (async () => {
      try {
        // Launch browser for cookie capture (visible for login)
        const browser = await puppeteer.launch(getPuppeteerConfig(true));
        const page = await browser.newPage();
        
        // Set user agent and other properties to look more like a regular browser
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        
        // Try to avoid detection
        await page.evaluateOnNewDocument(() => {
          // Remove webdriver property
          delete navigator.__proto__.webdriver;
          // Mock languages and plugins
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
          });
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });
        });
        
        // Navigate to Facebook
        console.log('Navigating to Facebook...');
        try {
          await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 });
        } catch (navError) {
          console.log('Navigation error:', navError.message);
          // Continue anyway
        }
        
        console.log('Facebook page loaded, current URL:', page.url());
        
        // Check if we got redirected or if there's an issue
        const currentUrl = page.url();
        console.log('Current URL check:', currentUrl);
        
        if (!currentUrl.includes('facebook.com') && !currentUrl.includes('localhost') && !currentUrl.includes('127.0.0.1')) {
          console.log('Warning: Not on Facebook domain, but continuing...');
        }
        
        // Show instructions
        await page.evaluate(() => {
          const div = document.createElement('div');
          div.innerHTML = `
            <div style="position:fixed;top:10px;left:10px;background:yellow;padding:15px;border:2px solid black;z-index:9999;font-size:14px;max-width:400px;">
              <strong>Facebook Cookie & Location Setup</strong><br>
              1. If asked for location permission, click "Allow"<br>
              2. Navigate to Marketplace if needed<br>
              3. This window will close automatically after setup completes.
            </div>
          `;
          document.body.appendChild(div);
        });
        
        // Wait for user to log in and grant location permission
        console.log('Waiting for Facebook login and location setup...');
        let loginDetected = false;
        try {
          await page.waitForFunction(() => {
            // Check for various indicators of being logged in and having marketplace access
            const feed = document.querySelector('[data-pagelet="Feed"]');
            const main = document.querySelector('[role="main"]');
            const marketplace = document.querySelector('[data-pagelet="Marketplace"]');
            const urlHasMarketplace = window.location.href.includes('/marketplace');
            const marketplaceLink = document.querySelector('a[href*="/marketplace"]');
            const searchElements = document.querySelector('input[type="search"]') && document.querySelector('[data-visualcompletion="ignore-dynamic"]');
            
            const found = !!(feed || main || marketplace || urlHasMarketplace || marketplaceLink || searchElements);
            
            // Debug logging (only log when something changes)
            if (found && !window._lastFound) {
              console.log('Found login indicators:', { feed: !!feed, main: !!main, marketplace: !!marketplace, urlHasMarketplace, marketplaceLink: !!marketplaceLink, searchElements: !!searchElements });
              window._lastFound = true;
            }
            
            return found;
          }, { timeout: 300000 }); // 5 minute timeout
          loginDetected = true;
          console.log('Login detected successfully');
        } catch (e) {
          console.log('Login detection timed out after 5 minutes, continuing with cookie capture...');
        }
        
        // Give a moment for any location permissions to be processed
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('Capturing cookies...');
        // Get cookies
        const cookies = await page.cookies();
        
        console.log(`Captured ${cookies.length} cookies`);
        // Save to file
        fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
        
        await browser.close();
        
        console.log('Cookies saved successfully');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    })();
  } else if (pathname === '/api/simple-login' && req.method === 'POST') {
    (async () => {
      let browser;
      try {
        console.log('Starting simple login flow...');
        browser = await puppeteer.launch(getPuppeteerConfig(true));  // Visible for login
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });

        console.log('Opening Facebook Marketplace...');
        // Use domcontentloaded instead of networkidle2 - faster, more reliable
        await page.goto('https://www.facebook.com/marketplace', {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        }).catch((err) => {
          console.log('Page load error (continuing anyway):', err.message);
        });

        // Give it a moment to settle
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Start auto-saving cookies every 2 seconds
        const cookieSaveInterval = setInterval(async () => {
          try {
            const cookies = await page.cookies();
            const hasAuth = cookies.some(c => c.name === 'c_user' || c.name === 'xs');
            if (hasAuth) {
              fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
              console.log(`Auto-saved ${cookies.length} cookies with authentication`);
            }
          } catch (e) {
            // Ignore errors during auto-save
          }
        }, 2000);

        // Show big message
        await page.evaluate(() => {
          const div = document.createElement('div');
          div.id = 'login-helper';
          div.innerHTML = `
            <div style="position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#4CAF50;padding:30px;border-radius:12px;z-index:999999;font-size:20px;color:white;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.3);max-width:600px;">
              <h2 style="margin:0 0 20px 0;">🔐 Facebook Login</h2>
              <p style="margin:0 0 15px 0;font-size:16px;">1. Log in to Facebook if prompted</p>
              <p style="margin:0 0 15px 0;font-size:16px;">2. Wait for Marketplace to load</p>
              <p style="margin:0 0 15px 0;font-size:16px;">3. Set your location if needed</p>
              <p style="margin:0;font-size:18px;font-weight:bold;">Then close this browser window!</p>
              <p style="margin:10px 0 0 0;font-size:14px;opacity:0.9;">(Your login is being saved automatically)</p>
            </div>
          `;
          document.body.appendChild(div);
        });

        // Wait for user to close the browser (20 min timeout for "forgot password" email flow)
        await new Promise((resolve, reject) => {
          browser.on('disconnected', () => {
            clearInterval(cookieSaveInterval);
            resolve();
          });
          setTimeout(() => {
            clearInterval(cookieSaveInterval);
            reject(new Error('Timeout after 20 minutes'));
          }, 1200000);
        });

        console.log('Browser closed by user');
        clearInterval(cookieSaveInterval);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Login error:', err);
        if (browser) {
          try { await browser.close(); } catch (e) {}
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    })();
  } else if (pathname === '/api/capture-location' && req.method === 'POST') {
    (async () => {
      let browser;
      try {
        console.log('Starting location capture process...');
        // Launch browser for location capture (visible for user interaction)
        browser = await puppeteer.launch(getPuppeteerConfig(true));
        const page = await browser.newPage();
        
        // Set user agent and other properties to look more like a regular browser
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        
        // Try to avoid detection
        await page.evaluateOnNewDocument(() => {
          // Remove webdriver property
          delete navigator.__proto__.webdriver;
          // Mock languages and plugins
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
          });
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });
        });
        
        console.log('Navigating to Facebook Marketplace...');
        await page.goto('https://www.facebook.com/marketplace/', { waitUntil: 'networkidle2', timeout: 30000 });
        
        console.log('Waiting for page to settle...');
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Check if we're on a login page
        const currentUrl = page.url();
        console.log('Current URL:', currentUrl);
        
        // Check for login page indicators
        const loginIndicators = [
          'input[type="password"]',
          'input[placeholder*="password" i]',
          'input[name*="password" i]',
          'input[placeholder*="email" i]',
          'input[placeholder*="phone" i]',
          '[data-testid*="login"]',
          'form[action*="login"]',
          'button[type="submit"]',
          'input[aria-label*="password" i]'
        ];
        
        let isLoginPage = false;
        for (const indicator of loginIndicators) {
          try {
            const element = await page.$(indicator);
            if (element) {
              console.log('Found login indicator:', indicator);
              isLoginPage = true;
              break;
            }
          } catch (e) {}
        }
        
        // Also check URL for login keywords
        const loginUrlKeywords = ['login', 'checkpoint', 'auth', 'signin'];
        const urlHasLogin = loginUrlKeywords.some(keyword => currentUrl.toLowerCase().includes(keyword));
        
        if (isLoginPage || urlHasLogin) {
          console.log('Detected login page. Showing manual login instructions...');
          
          await page.evaluate(() => {
            const div = document.createElement('div');
            div.innerHTML = `
              <div style="position:fixed;top:10px;left:10px;background:red;padding:20px;border:3px solid black;z-index:9999;font-size:16px;max-width:600px;color:white;">
                <strong>LOGIN REQUIRED</strong><br><br>
                <strong>Please log in to Facebook:</strong><br>
                1. Enter your email/phone and password<br>
                2. Click "Log In"<br>
                3. If 2FA is required, complete it<br>
                4. Navigate to Marketplace (if not redirected automatically)<br>
                5. Set your location to 37138<br>
                6. Close this browser window when done<br><br>
                <em>The scraper will capture your cookies when you close the window.</em>
              </div>
            `;
            document.body.appendChild(div);
          });
          
          // Wait for user to log in and navigate to marketplace
          console.log('Waiting for user to log in and navigate to marketplace...');
          
          // Monitor for successful login and marketplace navigation
          let loggedIn = false;
          
          page.on('framenavigated', async (frame) => {
            if (frame === page.mainFrame()) {
              const url = frame.url();
              console.log('Navigation detected:', url);
              
              if (url.includes('facebook.com/marketplace') && !url.includes('login')) {
                console.log('Marketplace loaded, capturing cookies...');
                
                try {
                  // Wait a moment for cookies to settle
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  
                  const cookies = await page.cookies();
                  console.log(`Captured ${cookies.length} cookies`);
                  
                  // Check if we have authentication cookies
                  const hasAuth = cookies.some(cookie => cookie.name === 'c_user' || cookie.name === 'xs');
                  console.log('Has authentication cookies:', hasAuth);
                  
                  if (hasAuth) {
                    fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
                    console.log('Authentication cookies saved successfully');
                    
                    // Show success message
                    await page.evaluate(() => {
                      const div = document.createElement('div');
                      div.innerHTML = `
                        <div style="position:fixed;top:10px;left:10px;background:green;padding:20px;border:3px solid darkgreen;z-index:9999;font-size:16px;color:white;">
                          <strong>✅ COOKIES CAPTURED!</strong><br><br>
                          You can now close this browser window.<br>
                          The scraper will use your authenticated session.
                        </div>
                      `;
                      document.body.appendChild(div);
                    });
                    
                    loggedIn = true;
                  } else {
                    console.log('No authentication cookies found, waiting for proper login...');
                  }
                } catch (err) {
                  console.error('Error capturing cookies:', err);
                }
              }
            }
          });
          
          // Wait for either successful login or timeout
          const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => resolve('timeout'), 300000); // 5 minutes
          });
          
          const loginPromise = new Promise((resolve) => {
            const checkLogin = setInterval(async () => {
              if (loggedIn) {
                clearInterval(checkLogin);
                resolve('logged_in');
              }
            }, 1000);
          });
          
          const result = await Promise.race([loginPromise, timeoutPromise]);
          
          if (result === 'logged_in') {
            console.log('Login successful, cookies captured');
            // Keep browser open briefly so user can see success message
            await new Promise(resolve => setTimeout(resolve, 3000));
            await browser.close();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, method: 'login_detected' }));
          } else {
            console.log('Login timeout');
            await browser.close();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Login timeout - no authentication detected' }));
          }
          return;
        }
        
        // If we're not on login page, proceed with location setting
        console.log('Not on login page, proceeding with location detection...');
        
        // First, let's see what location-related elements exist on the page
        const allLocationElements = await page.$$('[placeholder*="location" i], [placeholder*="city" i], [placeholder*="zip" i], [aria-label*="location" i], [data-testid*="location"], input[type="text"]');
        console.log(`Found ${allLocationElements.length} potential location elements`);
        
        // Log some details about these elements
        for (let i = 0; i < Math.min(allLocationElements.length, 5); i++) {
          try {
            const element = allLocationElements[i];
            const tagName = await page.evaluate(el => el.tagName, element);
            const placeholder = await page.evaluate(el => el.placeholder || '', element);
            const ariaLabel = await page.evaluate(el => el.getAttribute('aria-label') || '', element);
            const className = await page.evaluate(el => el.className || '', element);
            console.log(`Element ${i}: ${tagName} - placeholder: "${placeholder}" - aria-label: "${ariaLabel}" - class: "${className}"`);
          } catch (e) {
            console.log(`Error inspecting element ${i}:`, e.message);
          }
        }
        
        const locationSelectors = [
          // Common Facebook Marketplace selectors
          '[data-testid="marketplace-location-input"]',
          '[data-testid*="location"] input',
          '[role="combobox"][aria-label*="location" i]',
          '[role="combobox"][placeholder*="location" i]',
          'input[placeholder*="Where" i]',
          'input[placeholder*="City" i]',
          'input[placeholder*="ZIP" i]',
          'input[aria-label*="location" i]',
          'input[aria-label*="Location" i]',
          'input[name*="location" i]',
          // More generic selectors
          'input[type="text"][placeholder*="location" i]',
          'input[type="text"][placeholder*="city" i]',
          'input[type="text"][placeholder*="zip" i]',
          // Fallback - any input that might be location-related
          'input[autocomplete*="address" i]',
          'input[autocomplete*="postal-code" i]'
        ];
        
        let locationInput = null;
        for (const selector of locationSelectors) {
          try {
            locationInput = await page.$(selector);
            if (locationInput) {
              console.log('Found location input with selector:', selector);
              break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
        
        // If we still can't find it, try clicking on location-related buttons first
        if (!locationInput) {
          console.log('Trying to click location button to reveal input...');
          const locationButtons = [
            '[data-testid*="location"]',
            'button[aria-label*="location" i]',
            'button[aria-label*="Location" i]',
            '[role="button"]',
            'span',
            'div'
          ];
          
          for (const buttonSelector of locationButtons) {
            try {
              const buttons = await page.$$(buttonSelector);
              for (const button of buttons) {
                try {
                  const text = await page.evaluate(el => el.textContent || '', button);
                  if (text.toLowerCase().includes('location')) {
                    console.log('Clicking location button with text:', text);
                    await button.click();
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Try finding the input again after clicking
                    for (const selector of locationSelectors) {
                      try {
                        locationInput = await page.$(selector);
                        if (locationInput) {
                          console.log('Found location input after clicking button, selector:', selector);
                          break;
                        }
                      } catch (e) {}
                    }
                    if (locationInput) break;
                  }
                } catch (e) {}
              }
              if (locationInput) break;
            } catch (e) {
              console.log('Error with selector:', buttonSelector, e.message);
            }
          }
        }
        
        if (locationInput) {
          console.log('Setting location to 37138...');
          await locationInput.clear();
          await locationInput.type('37138');
          await page.keyboard.press('Enter');
          
          console.log('Location set. Waiting for results to load...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Show instructions
          await page.evaluate(() => {
            const div = document.createElement('div');
            div.innerHTML = `
              <div style="position:fixed;top:10px;left:10px;background:yellow;padding:15px;border:2px solid black;z-index:9999;font-size:14px;max-width:400px;">
                <strong>Location Set to 37138</strong><br>
                Check if you see Nashville-area items. If correct, the window will close automatically in 10 seconds.<br>
                <em>If wrong location, close this window manually.</em>
              </div>
            `;
            document.body.appendChild(div);
          });
          
          // Wait 10 seconds to let user verify location
          console.log('Waiting 10 seconds for location verification...');
          await new Promise(resolve => setTimeout(resolve, 10000));
          
          console.log('Capturing cookies with location...');
          const cookies = await page.cookies();
          
          console.log(`Captured ${cookies.length} cookies with location`);
          fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
          
          await browser.close();
          browser = null;
          
          console.log('Location and cookies saved successfully');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          // Manual fallback - show instructions for user to set location manually
          console.log('Could not find location input automatically. Showing manual instructions...');
          
          await page.evaluate(() => {
            const div = document.createElement('div');
            div.innerHTML = `
              <div style="position:fixed;top:10px;left:10px;background:orange;padding:20px;border:3px solid red;z-index:9999;font-size:16px;max-width:500px;">
                <strong>MANUAL LOCATION SETUP REQUIRED</strong><br><br>
                <strong>Steps:</strong><br>
                1. Click on the location field (usually shows current location)<br>
                2. Type "37138" and press Enter<br>
                3. Verify you see Nashville-area items<br>
                4. Close this browser window<br><br>
                <em>The scraper will capture cookies when you close the window.</em>
              </div>
            `;
            document.body.appendChild(div);
          });
          
          // Wait for user to close the window or set location manually
          console.log('Waiting for user to manually set location and close window...');
          
          // Listen for window close or timeout
          let closed = false;
          const closePromise = new Promise((resolve) => {
            browser.on('disconnected', () => {
              closed = true;
              resolve();
            });
          });
          
          const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
              if (!closed) {
                resolve();
              }
            }, 120000); // 2 minutes timeout
          });
          
          await Promise.race([closePromise, timeoutPromise]);
          
          if (closed) {
            console.log('Browser closed by user, capturing cookies...');
            try {
              const cookies = await page.cookies();
              console.log(`Captured ${cookies.length} cookies`);
              fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
              
              console.log('Cookies saved successfully');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, method: 'manual' }));
            } catch (err) {
              console.error('Error capturing cookies after manual setup:', err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Failed to capture cookies after manual setup' }));
            }
          } else {
            console.log('Timeout waiting for manual location setup');
            await browser.close();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Timeout waiting for manual location setup' }));
          }
        }
        
      } catch (err) {
        console.error('Location capture error:', err);
        if (browser) {
          try {
            await browser.close();
          } catch (e) {}
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    })();
  } else if (pathname === '/api/open-url' && req.method === 'POST') {
    // Open URL in system browser
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { url } = JSON.parse(body);
        if (url) {
          const { exec } = require('child_process');
          exec(`open "${url}"`, (err) => {
            if (err) {
              console.error('Error opening URL:', err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: err.message }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            }
          });
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No URL provided' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
  } else if (pathname === '/api/progress') {
    // Server-Sent Events for progress updates
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });
    
    // Send initial progress
    const sendProgress = (stage, progress, message) => {
      res.write(`data: ${JSON.stringify({ stage, progress, message })}\n\n`);
    };
    
    sendProgress('idle', 0, 'Ready to scrape');
    
    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);
    
    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(keepAlive);
    });
    
    // Store the response for progress updates
    global.progressClients = global.progressClients || [];
    global.progressClients.push(sendProgress);
    
    req.on('close', () => {
      global.progressClients = global.progressClients.filter(client => client !== sendProgress);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = process.env.PORT || 8020;
server.listen(PORT, () => {
  console.log(`🚀 Marketplace Finder UI running on http://localhost:${PORT}`);
});
