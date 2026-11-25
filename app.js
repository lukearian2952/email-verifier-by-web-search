// email-scraper-with-geonix.js
// Puppeteer + Axios email scraper with full Geonix residential proxy rotation,
// fail tracking, concurrency, and 5-min per-request timeout.

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const robotsParser = require("robots-parser");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth")();
const AnonymizeUA = require("puppeteer-extra-plugin-anonymize-ua")();
puppeteer.use(StealthPlugin);
puppeteer.use(AnonymizeUA);

const app = express();
const PORT = process.env.PORT || 44001;
app.use(express.json());

// ----------------------------
// Configuration
// ----------------------------
const MAX_CONCURRENT_REQUESTS = 3;
const REQUEST_QUEUE = [];
let activeRequests = 0;
const PER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// ----------------------------
// Geonix Proxy Config
// ----------------------------
const GEONIX_PROXY = {
  host: process.env.GEONIX_PROXY_HOST || "res.geonix.com",
  basePort: parseInt(process.env.GEONIX_PROXY_PORT || "10000", 10),
  username: process.env.GEONIX_PROXY_USER || "",
  password: process.env.GEONIX_PROXY_PASS || "",
  maxPorts: 15,
};
const PROXY_FAIL_THRESHOLD = 4;
const PROXY_REFRESH_INTERVAL = 10 * 60 * 1000; // re-test every 10 min

let healthyPorts = [];
const proxyFailCount = new Map();

// ----------------------------
// User Agents
// ----------------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
];

// ----------------------------
// Geonix Proxy Helpers
// ----------------------------
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // ignore SSL mismatches

function buildProxyUrl(port) {
  const { username, password, host } = GEONIX_PROXY;
  return `https://${encodeURIComponent(username)}:${encodeURIComponent(
    password
  )}@${host}:${port}`;
}

function getRandomPort() {
  let port;
  if (!healthyPorts.length) {
    port =
      GEONIX_PROXY.basePort + Math.floor(Math.random() * GEONIX_PROXY.maxPorts);
    console.log(
      `🔹 getRandomPort: No healthy ports, randomly selected port ${port}`
    );
  } else {
    port = healthyPorts[Math.floor(Math.random() * healthyPorts.length)];
    console.log(`🔹 getRandomPort: Selected healthy port ${port}`);
  }
  return port;
}

function newProxyAgent(port) {
  try {
    return new HttpsProxyAgent(buildProxyUrl(port));
  } catch {
    return new https.Agent({ rejectUnauthorized: false });
  }
}

async function testProxyPort(port) {
  const agent = newProxyAgent(port);
  try {
    const start = Date.now();
    const res = await axios.get("https://httpbin.org/ip", {
      timeout: 15000,
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      validateStatus: (s) => s === 200,
    });
    console.log(
      `✅ [Proxy ${port}] OK (${Date.now() - start}ms) via ${res.data.origin}`
    );
    return { port, ok: true };
  } catch {
    console.warn(`❌ [Proxy ${port}] failed`);
    return { port, ok: false };
  }
}

async function getHealthyProxies() {
  console.log("🔍 Testing Geonix proxy ports...");
  const results = await Promise.all(
    Array.from({ length: GEONIX_PROXY.maxPorts }, (_, i) =>
      testProxyPort(GEONIX_PROXY.basePort + i)
    )
  );
  const healthy = results.filter((r) => r.ok).map((r) => r.port);
  if (!healthy.length) {
    console.warn("⚠️ No healthy proxies — using all ports");
    return Array.from(
      { length: GEONIX_PROXY.maxPorts },
      (_, i) => GEONIX_PROXY.basePort + i
    );
  }
  console.log(`🌐 Healthy proxies: ${healthy.join(", ")}`);
  return healthy;
}

// Initial load and periodic refresh
(async () => {
  healthyPorts = await getHealthyProxies();
  setInterval(async () => {
    console.log("🔄 Re-testing Geonix proxies...");
    healthyPorts = await getHealthyProxies();
  }, PROXY_REFRESH_INTERVAL);
})();

function markProxyFailed(port) {
  const c = (proxyFailCount.get(port) || 0) + 1;
  proxyFailCount.set(port, c);
  console.log(`⚠️ Proxy ${port} fail count: ${c}`);
  if (c >= PROXY_FAIL_THRESHOLD) {
    healthyPorts = healthyPorts.filter((p) => p !== port);
    console.log(`❌ Proxy ${port} removed from healthyPorts`);
    proxyFailCount.delete(port);
  }
}
function markProxySuccess(port) {
  if (proxyFailCount.has(port)) {
    console.log(`✅ Proxy ${port} success, clearing fail count`);
    proxyFailCount.delete(port);
  }
}

// ----------------------------
// Axios fetch with proxy & retries
// ----------------------------
async function fetchHtmlWithAxios(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const port = getRandomPort();
    const agent = newProxyAgent(port);
    try {
      const res = await axios.get(url, {
        timeout: 30000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        headers: {
          "User-Agent":
            USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.google.com/",
        },
      });

      console.log(
        `✅  Page HTML loaded from ${url} (${res.data.length} chars)`
      );

      return res.data;
    } catch (err) {
      console.warn(
        `❌ Axios failed via port ${port} for ${url} (attempt ${i + 1}): ${
          err.message
        }\n${err.stack}`
      );
      if (i === retries - 1) {
        console.error(`❌ All Axios attempts failed for ${url}`);
        return null; // return null instead of throwing
      }
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
    }
  }
}

// ----------------------------
// Puppeteer helpers with Geonix
// ----------------------------
let sharedBrowser = null;
async function ensureBrowser() {
  if (sharedBrowser) return sharedBrowser;
  console.log("🦊 Launching shared Puppeteer browser...");
  sharedBrowser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: null,
  });
  console.log("🦊 Shared browser launched successfully");
  process.on("exit", async () => {
    if (sharedBrowser) await sharedBrowser.close();
  });
  process.on("SIGINT", async () => {
    if (sharedBrowser) await sharedBrowser.close();
    process.exit(0);
  });
  return sharedBrowser;
}

async function retryNavigation(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🦊 retryNavigation: Attempt ${i + 1} for ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      console.log(`✅ retryNavigation success for ${url}`);
      return;
    } catch (err) {
      console.warn(
        `⚠️ retryNavigation failed attempt ${i + 1} for ${url}: ${err.message}`
      );
      if (i === retries - 1) {
        console.error(`❌ All Axios attempts failed for ${url}`);
        return null; // return null instead of throwing
      }
      await sleep(1500 + Math.random() * 1500);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openWithPuppeteer(url, maxAttempts = 3) {
  const browser = await ensureBrowser();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = getRandomPort();
    const proxyHostport = `${GEONIX_PROXY.host}:${port}`;
    const page = await browser.newPage();
    try {
      await page.authenticate({
        username: GEONIX_PROXY.username,
        password: GEONIX_PROXY.password,
      });
      await page.setUserAgent(
        USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      );
      console.log(
        `🦊 [Puppeteer Attempt ${attempt}] Navigating ${url} via proxy ${proxyHostport}`
      );
      await page.goto(url, { waitUntil: "networkidle2", timeout: 100000 });
      const content = await page.content();

      await page.close();
      return content;
    } catch (err) {
      console.warn(`⚠️ Puppeteer attempt ${attempt} failed: ${err.message}`);
      await page.close();
      if (attempt === maxAttempts) {
        console.error(`❌ All Puppeteer attempts failed for ${url}`);
        return null; // return null instead of throwing
      }
      await sleep(2000 + Math.random() * 1000);
    }
  }
}

// ----------------------------
// Email extraction & helpers
// ----------------------------
function normalizeEmails(emails) {
  return emails.map((email) =>
    email
      .toLowerCase()
      .replace(/\s*\[at\]\s*|\s*\(at\)\s*/g, "@")
      .replace(/\s*\[dot\]\s*|\s*\(dot\)\s*/g, ".")
      .replace(/\s+/g, "")
  );
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
}
function findObfuscatedEmails(content) {
  const patterns = [
    /([a-zA-Z0-9._-]+)\s*\[at\]\s*([a-zA-Z0-9._-]+)\s*\[dot\]\s*([a-zA-Z0-9_-]+)/gi,
    /([a-zA-Z0-9._-]+)\(at\)([a-zA-Z0-9._-]+)\(dot\)([a-zA-Z0-9_-]+)/gi,
    /([a-zA-Z0-9._-]+)\s*@\s*\(followed by "\\w+\\.\\w+"\)/gi,
    /document\.write\(([^)]+)\)/gi,
  ];
  const found = [];
  patterns.forEach((p) => {
    let m;
    while ((m = p.exec(content)) !== null) {
      const reconstructed = m
        .slice(1)
        .join("@")
        .replace(/\[dot\]|\(dot\)/g, ".");
      found.push(reconstructed);
    }
  });
  return normalizeEmails(found);
}
function extractEmailsFromHtml(html) {
  const $ = cheerio.load(html);
  const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
  const textEmails = normalizeEmails(html.match(emailRegex) || []);
  const mailtoEmails = $('a[href^="mailto:"]')
    .map((i, el) =>
      $(el)
        .attr("href")
        .replace(/^mailto:/i, "")
    )
    .get();
  const scriptEmails = findObfuscatedEmails(html);
  const allEmails = Array.from(
    new Set([...textEmails, ...mailtoEmails, ...scriptEmails])
  ).filter(isValidEmail);
  if (allEmails.length)
    console.log(`📧 extractEmailsFromHtml: Found ${allEmails.join(", ")}`);
  return allEmails;
}

function isEmailMatchDomainOrCommon(email, targetDomain) {
  const commonDomains = ["gmail.com", "yahoo.com", "hotmail.com"];
  const emailDomain = email.split("@")[1].toLowerCase();
  return (
    emailDomain === targetDomain.toLowerCase() ||
    commonDomains.includes(emailDomain)
  );
}

// ----------------------------
// Robots.txt loader
// ----------------------------
function loadRobotsTxt(domain) {
  return new Promise((resolve) => {
    console.log(`🔹 Loading robots.txt for ${domain}`);
    https
      .get(`https://${domain}/robots.txt`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          console.log(`🔹 robots.txt loaded for ${domain}`);
          resolve(robotsParser(`${domain}/robots.txt`, data));
        });
      })
      .on("error", () => resolve({ isAllowed: () => true }));
  });
}

// ----------------------------
// Scraper class
// ----------------------------
class EmailScraperRef {
  constructor({ browser, targetDomain, ignoreRobots = true }) {
    this.browser = browser;
    this.targetDomain = targetDomain;
    this.ignoreRobots = ignoreRobots;
    this.queue = [];
    this.visitedUrls = new Set();
    this.emails = new Set();
    this.timeoutReached = false;
    this.robots = null;
  }

  async init(startUrl) {
    console.log(
      `🔹 Initializing scraper for ${this.targetDomain} with startUrl=${startUrl}`
    );
    this.robots = await loadRobotsTxt(this.targetDomain).catch(() => ({
      isAllowed: () => true,
    }));
    this.enqueue(startUrl);
  }

  enqueue(url) {
    if (url && !this.visitedUrls.has(url)) this.queue.push(url);
  }
  isAllowed(url) {
    return (
      this.ignoreRobots || this.robots.isAllowed(url, "EmailScraperRef") || true
    );
  }
  resolveUrl(link, base) {
    try {
      const r = new URL(link, base);
      if (r.hostname === new URL(base).hostname) return r.href;
    } catch {}
    return null;
  }

  async processQueue() {
    while (this.queue.length && !this.timeoutReached) {
      const url = this.queue.shift();
      if (!url || !this.isAllowed(url) || this.visitedUrls.has(url)) continue;
      this.visitedUrls.add(url);

      try {
        const html = await fetchHtmlWithAxios(url);
        const found = extractEmailsFromHtml(html);
        for (const e of found) {
          if (isEmailMatchDomainOrCommon(e, this.targetDomain)) {
            this.emails.add(e);
            this.timeoutReached = true;
            break;
          }
        }
        const $ = cheerio.load(html);
        $("a[href]").each((i, el) => {
          const r = this.resolveUrl($(el).attr("href"), url);
          if (r && !this.visitedUrls.has(r)) this.queue.push(r);
        });
        if (!this.timeoutReached) await this.processWithPuppeteer(url);
        await sleep(700 + Math.random() * 600);
      } catch (err) {
        console.error("Queue error", url, err.message);
      }
    }
  }

  async processWithPuppeteer(url) {
    const page = await this.browser.newPage();
    try {
      await page.setUserAgent(
        USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      );
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.google.com/",
      });
      const port = getRandomPort();
      await page.authenticate({
        username: GEONIX_PROXY.username,
        password: GEONIX_PROXY.password,
      });
      await retryNavigation(page, url, 3);
      const html = await page.content();
      const found = extractEmailsFromHtml(html);
      for (const e of found) {
        if (isEmailMatchDomainOrCommon(e, this.targetDomain)) {
          this.emails.add(e);
          this.timeoutReached = true;
          break;
        }
      }
      if (!this.timeoutReached) {
        const anchors = await page.$$eval("a[href]", (nodes) =>
          nodes.map((n) => n.getAttribute("href")).filter(Boolean)
        );
        anchors.forEach((l) => {
          const r = this.resolveUrl(l, url);
          if (r && !this.visitedUrls.has(r)) this.queue.push(r);
        });
      }
    } catch (err) {
      console.error("Puppeteer error", url, err.message);
    } finally {
      try {
        await page.close();
      } catch {}
    }
  }
}

// ----------------------------
// Queue Processing
// ----------------------------
async function scheduleProcessing() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || !REQUEST_QUEUE.length)
    return;
  while (activeRequests < MAX_CONCURRENT_REQUESTS && REQUEST_QUEUE.length) {
    const job = REQUEST_QUEUE.shift();
    activeRequests++;
    console.log(
      `🔹 Starting job for ${job.domain}, activeRequests=${activeRequests}`
    );
    handleJob(job).finally(() => {
      activeRequests--;
      console.log(
        `🔸 Job finished for ${job.domain}, activeRequests=${activeRequests}`
      );
      setImmediate(scheduleProcessing);
    });
  }
}

async function handleJob({ domain, startUrl, res, req }) {
  let clientDisconnected = false;
  req.on("close", () => (clientDisconnected = true));
  const browser = await ensureBrowser();
  const scraper = new EmailScraperRef({
    browser,
    targetDomain: domain,
    ignoreRobots: true,
  });
  await scraper.init(startUrl);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("Timeout reached")),
      PER_REQUEST_TIMEOUT_MS
    )
  );

  try {
    await Promise.race([scraper.processQueue(), timeoutPromise]);
    if (!clientDisconnected)
      res.json({
        emails: scraper.emails.values().next().value || "",
        status: scraper.emails.size ? "success" : "failed",
      });
  } catch (err) {
    if (!clientDisconnected)
      res.json({ emails: "", status: "failed", message: err.message });
  }
}

// ----------------------------
// Express Route
// ----------------------------
app.get("/verify/email", (req, res) => {
  const domain = (req.query.domain || req.query.website || "").trim();
  if (!domain)
    return res
      .status(400)
      .json({ emails: "", status: "failed", message: "domain required" });
  const startUrl = domain.startsWith("http") ? domain : `https://${domain}`;
  REQUEST_QUEUE.push({ domain, startUrl, res, req });
  setImmediate(scheduleProcessing);
});

// ----------------------------
// Start server
// ----------------------------
app.listen(PORT, async () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  await ensureBrowser();
  console.log("Shared browser launched and Geonix proxies loaded");
});
