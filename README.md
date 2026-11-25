# Email Finder by Web Search

A Node.js microservice that finds email addresses by crawling a domain's web pages. It uses Axios for fast HTML fetching with Puppeteer (stealth mode) as a fallback, routing all requests through rotating residential proxies.

## Features

- Crawls a domain's pages to discover email addresses
- Extracts emails from HTML text, `mailto:` links, and obfuscated patterns
- Axios + Puppeteer stealth plugin for JS-rendered pages
- Rotating residential proxy support via Geonix
- Automatic proxy health checking every 10 minutes
- Concurrency control (max 3 simultaneous scrape jobs)
- 5-minute per-request timeout
- Respects robots.txt (configurable)

## Prerequisites

- Node.js >= 14.0.0
- Chromium / Google Chrome (for Puppeteer)

## Installation

```bash
git clone https://github.com/lukearian2952/email-verifier-by-web-search.git
cd email-verifier-by-web-search
npm install
cp .env.example .env
# Fill in your proxy credentials in .env
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `44001` |
| `GEONIX_PROXY_HOST` | Proxy hostname | `res.geonix.com` |
| `GEONIX_PROXY_PORT` | Proxy base port | `10000` |
| `GEONIX_PROXY_USER` | Proxy username | *(required)* |
| `GEONIX_PROXY_PASS` | Proxy password | *(required)* |

## Usage

```bash
npm start
```

## API

### `GET /verify/email?domain=<domain>`

Crawls the given domain and returns any email addresses found.

**Query Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | string | Yes | The domain to scrape (also accepts `website`) |

**Response:**

```json
{
  "emails": "contact@example.com",
  "status": "success"
}
```

**Possible `status` values:**

| Status | Description |
|---|---|
| `success` | At least one email was found |
| `failed` | No emails found or an error occurred |

## How It Works

1. Queues the domain for processing (max 3 concurrent jobs)
2. Loads robots.txt for the domain
3. Fetches the start URL via Axios with rotating proxy
4. Extracts emails from HTML (regex, mailto links, obfuscated patterns)
5. If no email found, retries with Puppeteer stealth mode
6. Follows internal links to discover more pages
7. Stops as soon as a matching email is found or timeout is reached

## Security Notes

- TLS certificate verification is disabled globally to handle proxy certificate mismatches
- Uses Puppeteer stealth plugin to avoid bot detection

## License

MIT
