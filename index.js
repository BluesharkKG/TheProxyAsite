const express = require("express");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const cookieParser = require("cookie-parser");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;

app.use(cors({ origin: "*" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "permissions-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy"
]);

function buildProxyUrl(absoluteUrl) {
  return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value || "");
}

function normalizeUrl(input, baseUrl) {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  if (raw.startsWith("javascript:") || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) {
    return null;
  }

  try {
    if (baseUrl) {
      return new URL(raw, baseUrl).toString();
    }

    if (isHttpUrl(raw)) {
      return new URL(raw).toString();
    }

    return new URL(`https://${raw}`).toString();
  } catch {
    return null;
  }
}

function rewriteCssUrls(css, baseUrl) {
  if (typeof css !== "string") return css;
  return css.replace(/url\((['"]?)([^'"\)]+)\1\)/gi, (_match, quote, resource) => {
    const absolute = normalizeUrl(resource, baseUrl);
    if (!absolute) return `url(${quote}${resource}${quote})`;
    return `url(${quote}${buildProxyUrl(absolute)}${quote})`;
  });
}

function rewriteSrcset(srcset, baseUrl) {
  if (!srcset || typeof srcset !== "string") return srcset;
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const [urlPart, descriptor] = trimmed.split(/\s+/, 2);
      const absolute = normalizeUrl(urlPart, baseUrl);
      if (!absolute) return trimmed;
      return `${buildProxyUrl(absolute)}${descriptor ? ` ${descriptor}` : ""}`;
    })
    .join(", ");
}

function rewriteRefresh(content, baseUrl) {
  if (!content || typeof content !== "string") return content;
  const match = content.match(/(.*?url=)(.*)$/i);
  if (!match) return content;
  const [, prefix, value] = match;
  const absolute = normalizeUrl(value.trim().replace(/^['"]|['"]$/g, ""), baseUrl);
  if (!absolute) return content;
  return `${prefix}${buildProxyUrl(absolute)}`;
}

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const attrPairs = [
    ["a", "href"],
    ["img", "src"],
    ["script", "src"],
    ["link", "href"],
    ["form", "action"],
    ["iframe", "src"],
    ["source", "src"]
  ];

  for (const [selector, attr] of attrPairs) {
    $(selector).each((_idx, element) => {
      const current = $(element).attr(attr);
      const absolute = normalizeUrl(current, baseUrl);
      if (absolute) {
        $(element).attr(attr, buildProxyUrl(absolute));
      }
    });
  }

  $("[srcset]").each((_idx, element) => {
    const updated = rewriteSrcset($(element).attr("srcset"), baseUrl);
    $(element).attr("srcset", updated);
  });

  $("style").each((_idx, element) => {
    const css = $(element).html();
    $(element).html(rewriteCssUrls(css, baseUrl));
  });

  $("[style]").each((_idx, element) => {
    const css = $(element).attr("style");
    $(element).attr("style", rewriteCssUrls(css, baseUrl));
  });

  $("meta[http-equiv]").each((_idx, element) => {
    const equiv = ($(element).attr("http-equiv") || "").toLowerCase();
    if (equiv === "refresh") {
      const content = $(element).attr("content");
      $(element).attr("content", rewriteRefresh(content, baseUrl));
    }
  });

  return $.html();
}

function cleanResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIP_RESPONSE_HEADERS.has(lower)) continue;
    result[key] = value;
  }
  return result;
}

function mapSetCookieForProxy(setCookieHeaders = []) {
  return setCookieHeaders.map((cookie) => {
    let updated = cookie;
    if (/;\s*SameSite=/i.test(updated)) {
      updated = updated.replace(/;\s*SameSite=[^;]+/gi, "; SameSite=None");
    } else {
      updated += "; SameSite=None";
    }

    if (!/;\s*Secure/i.test(updated)) {
      updated += "; Secure";
    }

    return updated;
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "theproxyasite", timestamp: new Date().toISOString() });
});

app.get("/proxy", async (req, res) => {
  const normalizedTarget = normalizeUrl(req.query.url);
  if (!normalizedTarget) {
    return res.status(400).json({ error: "Invalid or missing url query parameter" });
  }

  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar }));

  const incomingCookie = req.headers.cookie;
  if (incomingCookie) {
    const cookies = incomingCookie.split(";").map((part) => part.trim()).filter(Boolean);
    for (const cookie of cookies) {
      try {
        await jar.setCookie(cookie, normalizedTarget);
      } catch {
        // Ignore malformed cookie segments.
      }
    }
  }

  const requestHeaders = {
    "user-agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept: req.headers.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
    "accept-encoding": "identity"
  };

  try {
    const response = await client.get(normalizedTarget, {
      headers: requestHeaders,
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_CONTENT_LENGTH,
      responseType: "arraybuffer",
      validateStatus: () => true
    });

    const responseHeaders = cleanResponseHeaders(response.headers);
    const contentType = (response.headers["content-type"] || "application/octet-stream").toLowerCase();

    if (responseHeaders.location) {
      const redirected = normalizeUrl(responseHeaders.location, normalizedTarget);
      if (redirected) {
        responseHeaders.location = buildProxyUrl(redirected);
      }
    }

    const setCookie = response.headers["set-cookie"];
    if (setCookie && Array.isArray(setCookie)) {
      res.setHeader("set-cookie", mapSetCookieForProxy(setCookie));
    }

    for (const [key, value] of Object.entries(responseHeaders)) {
      if (key.toLowerCase() === "set-cookie") continue;
      res.setHeader(key, value);
    }

    res.status(response.status);

    if (contentType.includes("application/json")) {
      const text = Buffer.from(response.data).toString("utf8");
      return res.type("application/json").send(text);
    }

    if (contentType.includes("text/html")) {
      const html = Buffer.from(response.data).toString("utf8");
      const rewritten = rewriteHtml(html, normalizedTarget);
      return res.type("text/html").send(rewritten);
    }

    if (contentType.includes("text/css")) {
      const css = Buffer.from(response.data).toString("utf8");
      const rewrittenCss = rewriteCssUrls(css, normalizedTarget);
      return res.type("text/css").send(rewrittenCss);
    }

    return res.send(Buffer.from(response.data));
  } catch (error) {
    const status = error.response?.status || 502;
    return res.status(status).json({
      error: "Proxy request failed",
      details: error.message,
      target: normalizedTarget
    });
  }
});

app.listen(PORT, () => {
  console.log(`TheProxyASite listening on port ${PORT}`);
});
