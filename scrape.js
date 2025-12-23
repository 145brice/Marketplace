const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrape() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  const cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
  await page.setCookie(...cookies);
  await page.goto('https://www.facebook.com/marketplace/category/riding-lawn-mowers', { waitUntil: 'networkidle2' });
  
  const deals = await page.evaluate(() => {
    const posts = Array.from(document.querySelectorAll('a[href*="/p/"]')).slice(0, 10);
    return posts.map(p => ({
      title: p.querySelector('span')?.innerText || 'No title',
      price: p.querySelector('span span')?.innerText || 'N/A',
      link: 'https://www.facebook.com' + p.getAttribute('href')
    }));
  });
  
  console.log('Found:', deals);
  // TODO: text me later
  await browser.close();
}

scrape();
