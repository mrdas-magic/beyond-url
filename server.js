
const express = require("express");
const cheerio = require("cheerio");
const dns = require("node:dns/promises");
const net = require("node:net");
const ipaddr = require("ipaddr.js");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const MAX_REDIRECTS = 5;
const TIMEOUT = 12000;
const MAX_HTML_SIZE = 2 * 1024 * 1024;

function isPublicIP(ip) {
  try {
    const address = ipaddr.parse(ip);
    return address.range() === "unicast";
  } catch {
    return false;
  }
}

async function validateURL(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are supported");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Private addresses are not allowed");
  }

  if (net.isIP(hostname)) {
    if (!isPublicIP(hostname)) {
      throw new Error("Private IP addresses are not allowed");
    }
  } else {
    const records = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    });

    if (!records.length || records.some(r => !isPublicIP(r.address))) {
      throw new Error("Unsafe hostname");
    }
  }

  return url;
}

async function fetchPage(value, redirects = 0) {
  const url = await validateURL(value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinkViewer/1.0)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error("Too many redirects");
      }

      const location = response.headers.get("location");

      if (!location) {
        throw new Error("Invalid redirect");
      }

      const nextURL = new URL(location, url).href;
      await response.body?.cancel();

      return fetchPage(nextURL, redirects + 1);
    }

    if (!response.ok) {
      throw new Error(`Website returned ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error("URL does not contain an HTML page");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;

      if (total > MAX_HTML_SIZE) {
        await reader.cancel();
        throw new Error("Website HTML is too large");
      }

      chunks.push(value);
    }

    return {
      html: Buffer.concat(chunks).toString("utf8"),
      finalURL: url.href
    };

  } finally {
    clearTimeout(timer);
  }
}

function getMeta($, selectors) {
  for (const selector of selectors) {
    const value = $(selector).first().attr("content");

    if (value && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function extractPreview(html, pageURL) {
  const $ = cheerio.load(html);

  const title =
    getMeta($, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]'
    ]) ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "Untitled Website";

  const description =
    getMeta($, [
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]'
    ]) ||
    $("main p").first().text().trim() ||
    $("article p").first().text().trim() ||
    $("p").first().text().trim() ||
    "";

  const siteName =
    getMeta($, [
      'meta[property="og:site_name"]'
    ]) ||
    new URL(pageURL).hostname;

  const imageCandidates = [
    getMeta($, ['meta[property="og:image:secure_url"]']),
    getMeta($, ['meta[property="og:image"]']),
    getMeta($, ['meta[name="twitter:image"]']),
    getMeta($, ['meta[name="twitter:image:src"]'])
  ];

  // Find the first usable image from the page.
  $("img").each((_, element) => {
    const img = $(element);

    const src =
      img.attr("src") ||
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original");

    if (src) imageCandidates.push(src);
  });

  let image = "";

  for (const candidate of imageCandidates) {
    if (!candidate) continue;

    try {
      const parsed = new URL(candidate, pageURL);

      if (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.hostname.endsWith(".local")
      ) {
        image = parsed.href;
        break;
      }
    } catch {
      // Try the next image.
    }
  }

  const favicon =
    $('link[rel~="icon"]').first().attr("href") ||
    $('link[rel="apple-touch-icon"]').first().attr("href") ||
    "/favicon.ico";

  let faviconURL;

  try {
    faviconURL = new URL(favicon, pageURL).href;
  } catch {
    faviconURL = "";
  }

  const cleanText = description
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  return {
    title: title.replace(/\s+/g, " ").trim(),
    description: cleanText || "No description available.",
    siteName,
    image,
    favicon: faviconURL,
    url: pageURL
  };
}

app.post("/api/preview", async (req, res) => {
  try {
    const { url } = req.body;

    if (typeof url !== "string" || url.length > 2048) {
      return res.status(400).json({
        error: "Invalid URL"
      });
    }

    const result = await fetchPage(url);
    const preview = extractPreview(
      result.html,
      result.finalURL
    );

    res.json(preview);

  } catch (error) {
    console.error("Preview error:", error.message);

    res.status(422).json({
      error: error.message || "Unable to fetch website"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Link Viewer running at http://localhost:${PORT}`);
});


