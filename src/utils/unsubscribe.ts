/**
 * Unsubscribe Utilities
 *
 * Inbox-agnostic helpers for unsubscribing from mailing lists using the
 * standard List-Unsubscribe headers. They work on raw RFC 822 headers from any
 * source: Mail.app's `all headers`, a Gmail API RAW message, or a .eml file.
 *
 * Methods, in order of preference:
 * 1. one-click — RFC 8058 HTTPS POST (`List-Unsubscribe=One-Click`)
 * 2. mailto    — RFC 2369 unsubscribe email
 * 3. web       — RFC 2369 HTTPS page that a person must finish
 *
 * Every method requires the List-Unsubscribe header to be protected by a DKIM
 * signature that passed, as reported by a trusted receiving server, for a
 * domain aligned with the From address. This stops a forged or spoofed message
 * from pointing an unsubscribe request somewhere else.
 *
 * @module utils/unsubscribe
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { isAbsolute, resolve } from "path";

// =============================================================================
// Types
// =============================================================================

/** Unsubscribe methods, in order of preference. */
export type UnsubscribeMethod = "one-click" | "mailto" | "web";

/** Where and what to send for a mailto unsubscribe. */
export interface MailtoTarget {
  address: string;
  subject: string;
  body: string;
}

/** DKIM verdict for the List-Unsubscribe headers. */
export interface DkimVerdict {
  /** A trusted receiver reported dkim=pass for a domain aligned with From */
  verified: boolean;
  /** The aligned, passing DKIM domain */
  domain: string | null;
  /** The aligned signature covers List-Unsubscribe */
  coversListUnsubscribe: boolean;
  /** The aligned signature covers List-Unsubscribe-Post */
  coversListUnsubscribePost: boolean;
}

/** Result of analyzing a message's unsubscribe headers. */
export interface UnsubscribeAnalysis {
  from: string | null;
  fromDomain: string | null;
  dkim: DkimVerdict;
  httpsUrl: string | null;
  mailto: MailtoTarget | null;
  oneClickHeader: boolean;
  /** Eligible methods, in order of preference */
  methods: UnsubscribeMethod[];
  /** Why each other method can't be used */
  ineligible: { method: UnsubscribeMethod; reason: string }[];
}

/** Result of a one-click unsubscribe request. */
export interface OneClickResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Receiving servers whose Authentication-Results headers we trust. Receivers
 * strip headers claiming their own authserv-id from incoming mail, so a sender
 * can't forge these.
 */
export const TRUSTED_AUTHSERV_PATTERNS: RegExp[] = [/^mx\.google\.com$/i, /(^|\.)icloud\.com$/i];

const MAX_URL_LENGTH = 4096;
const MAX_RAW_FILE_BYTES = 50 * 1024 * 1024;
const ONE_CLICK_TIMEOUT_MS = 15_000;
const ALLOWED_FILE_PREFIXES = [realpathSync(homedir()), realpathSync(tmpdir()), "/private/tmp"];

// =============================================================================
// Header Parsing
// =============================================================================

/**
 * Parses the header block of a raw RFC 822 message into a map of
 * lower-cased header name → values (in order). Folded lines are unfolded.
 * Parsing stops at the first empty line, so a full message can be passed.
 */
export function parseHeaders(raw: string): Map<string, string[]> {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const end = normalized.indexOf("\n\n");
  const block = end === -1 ? normalized : normalized.slice(0, end);

  const headers = new Map<string, string[]>();
  let name: string | null = null;
  let value = "";

  const flush = () => {
    if (name === null) return;
    const key = name.toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), value.trim()]);
  };

  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && name !== null) {
      value += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    flush();
    name = line.slice(0, colon).trim();
    value = line.slice(colon + 1);
  }
  flush();

  return headers;
}

/** Extracts the bare address from a From header value. */
export function extractAddress(from: string): string | null {
  const bracketed = from.match(/<([^>]+)>/);
  const candidate = (bracketed ? bracketed[1] : from).trim();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/** Returns the domain part of an email address. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Splits a List-Unsubscribe value into its URIs. Whitespace inside angle
 * brackets is ignored, per RFC 2369.
 */
export function parseListUnsubscribe(value: string): string[] {
  return [...value.matchAll(/<([^>]*)>/g)].map((m) => m[1].replace(/\s+/g, "")).filter(Boolean);
}

/** Parses a mailto: URI into a single-recipient unsubscribe target. */
export function parseMailto(uri: string): MailtoTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "mailto:") return null;

  let address: string;
  try {
    address = decodeURIComponent(url.pathname).trim();
  } catch {
    return null;
  }
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(address)) return null;

  const clean = (text: string | null, fallback: string, max: number) =>
    (text ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control chars (e.g. CRLF header injection) is the point
      .replace(/[\0-\x1f\x7f]/g, " ")
      .trim()
      .slice(0, max) || fallback;

  return {
    address: address.toLowerCase(),
    subject: clean(url.searchParams.get("subject"), "unsubscribe", 200),
    body: clean(url.searchParams.get("body"), "unsubscribe", 1000),
  };
}

/** True for an https URL that is safe to send an unsubscribe request to. */
export function isSafeHttpsUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  // Refuse IP literals (IPv4 or bracketed IPv6) — real list servers use hostnames
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return false;
  return host.includes(".");
}

// =============================================================================
// DKIM Verification
// =============================================================================

/** Strips RFC 5322 comments like "(google.com: domain of ...)". */
function stripComments(value: string): string {
  return value.replace(/\([^()]*\)/g, "");
}

/**
 * Collects DKIM domains that passed, according to Authentication-Results
 * headers from trusted receivers only.
 */
export function passingDkimDomains(authResults: string[]): Set<string> {
  const domains = new Set<string>();

  for (const header of authResults) {
    const parts = stripComments(header).split(";");
    const authservId = parts[0].trim().split(/\s+/)[0] ?? "";
    if (!TRUSTED_AUTHSERV_PATTERNS.some((p) => p.test(authservId))) continue;

    for (const part of parts.slice(1)) {
      if (!/^\s*dkim\s*=\s*pass\b/i.test(part)) continue;
      const d = part.match(/header\.d\s*=\s*([^\s;]+)/i);
      const i = part.match(/header\.i\s*=\s*([^\s;]+)/i);
      if (d) domains.add(d[1].toLowerCase());
      else if (i && i[1].includes("@")) domains.add(domainOf(i[1]));
    }
  }

  return domains;
}

/** Parses a DKIM-Signature header into its d= domain and signed header names. */
export function parseDkimSignature(value: string): { domain: string; signed: string[] } | null {
  const tags = new Map<string, string>();
  for (const tag of value.split(";")) {
    const eq = tag.indexOf("=");
    if (eq <= 0) continue;
    tags.set(tag.slice(0, eq).trim().toLowerCase(), tag.slice(eq + 1).replace(/\s+/g, ""));
  }
  const domain = tags.get("d");
  const signed = tags.get("h");
  if (!domain || !signed) return null;
  return {
    domain: domain.toLowerCase(),
    signed: signed
      .split(":")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Relaxed DMARC-style alignment: the DKIM domain equals the From domain, or one
 * is a subdomain of the other.
 */
export function isAligned(dkimDomain: string, fromDomain: string): boolean {
  if (!dkimDomain.includes(".")) return false;
  return (
    dkimDomain === fromDomain ||
    fromDomain.endsWith("." + dkimDomain) ||
    dkimDomain.endsWith("." + fromDomain)
  );
}

/** Works out whether the List-Unsubscribe headers are DKIM-protected. */
export function verifyDkim(headers: Map<string, string[]>, fromDomain: string | null): DkimVerdict {
  const verdict: DkimVerdict = {
    verified: false,
    domain: null,
    coversListUnsubscribe: false,
    coversListUnsubscribePost: false,
  };
  if (!fromDomain) return verdict;

  const passing = passingDkimDomains(headers.get("authentication-results") ?? []);
  const signatures = (headers.get("dkim-signature") ?? [])
    .map(parseDkimSignature)
    .filter((sig): sig is NonNullable<typeof sig> => sig !== null);

  for (const sig of signatures) {
    if (!passing.has(sig.domain) || !isAligned(sig.domain, fromDomain)) continue;
    verdict.verified = true;
    verdict.domain ??= sig.domain;
    if (sig.signed.includes("list-unsubscribe")) {
      verdict.coversListUnsubscribe = true;
      verdict.domain = sig.domain;
    }
    if (sig.signed.includes("list-unsubscribe-post")) verdict.coversListUnsubscribePost = true;
  }

  return verdict;
}

// =============================================================================
// Analysis
// =============================================================================

/**
 * Analyzes a raw message's headers and decides which unsubscribe methods can
 * safely be used.
 */
export function analyzeUnsubscribe(raw: string): UnsubscribeAnalysis {
  const headers = parseHeaders(raw);
  const fromHeader = headers.get("from")?.[0] ?? null;
  const fromAddress = fromHeader ? extractAddress(fromHeader) : null;
  const fromDomain = fromAddress ? domainOf(fromAddress) : null;

  const uris = (headers.get("list-unsubscribe") ?? []).flatMap(parseListUnsubscribe);
  const httpsUrl = uris.find((u) => /^https:/i.test(u)) ?? null;
  const mailtoUri = uris.find((u) => /^mailto:/i.test(u)) ?? null;
  const mailto = mailtoUri ? parseMailto(mailtoUri) : null;
  const oneClickHeader = (headers.get("list-unsubscribe-post") ?? []).some(
    (v) => v.replace(/\s+/g, "").toLowerCase() === "list-unsubscribe=one-click"
  );

  const dkim = verifyDkim(headers, fromDomain);
  const methods: UnsubscribeMethod[] = [];
  const ineligible: UnsubscribeAnalysis["ineligible"] = [];

  // A shared precondition for every method
  let trustProblem: string | null = null;
  if (uris.length === 0) trustProblem = "no List-Unsubscribe header";
  else if (!fromDomain) trustProblem = "From address could not be parsed";
  else if (!dkim.verified) trustProblem = `no passing DKIM signature aligned with ${fromDomain}`;
  else if (!dkim.coversListUnsubscribe)
    trustProblem = "DKIM signature does not cover List-Unsubscribe";

  const consider = (method: UnsubscribeMethod, problem: string | null) => {
    const reason = trustProblem ?? problem;
    if (reason) ineligible.push({ method, reason });
    else methods.push(method);
  };

  consider(
    "one-click",
    !httpsUrl
      ? "no https unsubscribe URL"
      : !oneClickHeader
        ? "sender doesn't support one-click (no List-Unsubscribe-Post)"
        : !dkim.coversListUnsubscribePost
          ? "DKIM signature does not cover List-Unsubscribe-Post"
          : !isSafeHttpsUrl(httpsUrl)
            ? "unsubscribe URL failed safety checks"
            : null
  );
  consider(
    "mailto",
    !mailtoUri
      ? "no mailto unsubscribe address"
      : !mailto
        ? "mailto address could not be parsed"
        : null
  );
  consider(
    "web",
    !httpsUrl
      ? "no https unsubscribe URL"
      : !isSafeHttpsUrl(httpsUrl)
        ? "unsubscribe URL failed safety checks"
        : null
  );

  return {
    from: fromHeader,
    fromDomain,
    dkim,
    httpsUrl,
    mailto,
    oneClickHeader,
    methods,
    ineligible,
  };
}

/** Formats an analysis as readable text for a tool response. */
export function formatUnsubscribeAnalysis(analysis: UnsubscribeAnalysis): string {
  const lines = [
    `From: ${analysis.from ?? "(unknown)"}`,
    `DKIM: ${
      analysis.dkim.verified
        ? `pass for ${analysis.dkim.domain} (covers List-Unsubscribe: ${analysis.dkim.coversListUnsubscribe ? "yes" : "no"}, List-Unsubscribe-Post: ${analysis.dkim.coversListUnsubscribePost ? "yes" : "no"})`
        : "not verified"
    }`,
    `Available methods (in order): ${analysis.methods.length ? analysis.methods.join(", ") : "none"}`,
  ];
  for (const { method, reason } of analysis.ineligible) {
    lines.push(`  - ${method}: unavailable — ${reason}`);
  }
  if (analysis.mailto && analysis.methods.includes("mailto")) {
    lines.push(
      `Mailto: ${analysis.mailto.address} (subject "${analysis.mailto.subject}", body "${analysis.mailto.body}")`
    );
  }
  if (analysis.httpsUrl && analysis.methods.includes("web")) {
    lines.push(`Web unsubscribe page: ${analysis.httpsUrl}`);
  }
  return lines.join("\n");
}

// =============================================================================
// Actions
// =============================================================================

/**
 * Sends an RFC 8058 one-click unsubscribe request. No cookies are sent and
 * redirects are not followed; only a 2xx response counts as success.
 */
export async function performOneClickUnsubscribe(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = ONE_CLICK_TIMEOUT_MS
): Promise<OneClickResult> {
  if (!isSafeHttpsUrl(url)) {
    return { ok: false, error: "Refusing an unsafe unsubscribe URL" };
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: `Server responded ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reads a raw message from disk: either a raw RFC 822 file (.eml) or a JSON
 * file with a base64url `raw` field, such as a saved Gmail API RAW response.
 *
 * @throws Error if the path is unsafe, missing, too large, or unreadable
 */
export function readRawMessageFile(filePath: string): string {
  if (!isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: "${filePath}"`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`File not found: "${filePath}"`);
  }
  // Resolve symlinks and ".." before checking the location
  const resolved = realpathSync(resolve(filePath));
  if (!ALLOWED_FILE_PREFIXES.some((prefix) => resolved.startsWith(prefix + "/"))) {
    throw new Error(`Path is outside allowed directories: "${filePath}"`);
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`Not a file: "${filePath}"`);
  }
  if (statSync(resolved).size > MAX_RAW_FILE_BYTES) {
    throw new Error("File is too large to be an email message");
  }

  const text = readFileSync(resolved, "utf8");
  if (!text.trimStart().startsWith("{")) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File looks like JSON but could not be parsed");
  }
  const raw = (parsed as { raw?: unknown }).raw;
  if (typeof raw !== "string") {
    throw new Error('JSON file has no string "raw" field');
  }
  return Buffer.from(raw, "base64url").toString("utf8");
}

/**
 * Picks the address to send a mailto unsubscribe from: the account address the
 * message was delivered to, falling back to the account's first address.
 */
export function pickSenderAddress(raw: string, accountAddresses: string[]): string | null {
  const addresses = accountAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (addresses.length === 0) return null;

  const headers = parseHeaders(raw);
  const recipientText = ["delivered-to", "to", "cc", "x-original-to"]
    .flatMap((name) => headers.get(name) ?? [])
    .join(" ")
    .toLowerCase();

  return addresses.find((a) => recipientText.includes(a)) ?? addresses[0];
}
