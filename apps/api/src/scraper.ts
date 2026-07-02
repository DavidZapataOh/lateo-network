// The `url-to-json` service (CONTEXT §9): a ONE-page scraper -> structured JSON. Dep-free minimal
// extraction (title/description/h1); a fetch failure throws so serveAndSettle voids the payment.

export interface ScrapedJson {
  title: string | null;
  description: string | null;
  h1: string | null;
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null;
}

/** Read a <meta> content by name/property, tolerant of attribute order. */
function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /(?:name|property)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() === key) return /content=["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? null;
  }
  return null;
}

/** Pure, deterministic HTML -> JSON extraction (one page). */
export function parseHtmlToJson(html: string): ScrapedJson {
  return {
    title: firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: metaContent(html, 'description') ?? metaContent(html, 'og:description'),
    h1: firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
  };
}

/** Fetch ONE page and parse it. Throws on non-2xx / network failure (delivery failure -> void). */
export async function scrapeUrlToJson(url: string): Promise<ScrapedJson> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`scrape failed: ${res.status} ${url}`);
  return parseHtmlToJson(await res.text());
}
