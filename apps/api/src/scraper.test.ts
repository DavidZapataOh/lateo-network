import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseHtmlToJson, scrapeUrlToJson } from './scraper.js';

const FIXTURE = `<!doctype html><html><head>
  <title>  Example Page  </title>
  <meta charset="utf-8">
  <meta content="A one-page description." name="description">
</head><body><h1>Main <em>Heading</em></h1><p>body</p></body></html>`;

describe('2.3 T9 — parseHtmlToJson (pure, deterministic)', () => {
  it('extracts title, description (attr order independent), and h1 (tags stripped)', () => {
    expect(parseHtmlToJson(FIXTURE)).toEqual({
      title: 'Example Page',
      description: 'A one-page description.',
      h1: 'Main Heading',
    });
  });

  it('missing fields -> null (no crash)', () => {
    expect(parseHtmlToJson('<html><head></head><body>nothing</body></html>')).toEqual({
      title: null,
      description: null,
      h1: null,
    });
  });
});

describe('2.3 T9 — scrapeUrlToJson (real fetch against a local fixture server)', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FIXTURE);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fetches one page and returns structured JSON', async () => {
    expect(await scrapeUrlToJson(`${base}/ok`)).toEqual({
      title: 'Example Page',
      description: 'A one-page description.',
      h1: 'Main Heading',
    });
  });

  it('unreachable / non-2xx URL throws -> serveAndSettle will VOID (delivery failed)', async () => {
    await expect(scrapeUrlToJson(`${base}/missing`)).rejects.toThrow();
  });
});
