/**
 * Tests for the inbox-agnostic unsubscribe utilities.
 *
 * Fixtures are modelled on real headers: iCloud (separate Authentication-Results
 * per check, header.d=) and Gmail (one mx.google.com header, header.i=).
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  analyzeUnsubscribe,
  extractAddress,
  formatUnsubscribeAnalysis,
  isAligned,
  isSafeHttpsUrl,
  parseDkimSignature,
  parseHeaders,
  parseListUnsubscribe,
  parseMailto,
  passingDkimDomains,
  performOneClickUnsubscribe,
  pickSenderAddress,
  readRawMessageFile,
} from "./unsubscribe.js";

// =============================================================================
// Fixtures
// =============================================================================

interface FixtureOptions {
  from?: string;
  authResults?: string[];
  dkimDomain?: string;
  signed?: string;
  listUnsubscribe?: string | null;
  post?: string | null;
  to?: string;
}

function buildHeaders(opts: FixtureOptions = {}): string {
  const {
    from = '"Glovo" <toktok@info.glovoapp.com>',
    authResults = [
      "dkim-verifier.icloud.com; dkim=pass header.d=info.glovoapp.com header.i=@info.glovoapp.com header.b=DZBVY4AN",
      "dmarc.icloud.com; dmarc=pass header.from=info.glovoapp.com",
    ],
    dkimDomain = "info.glovoapp.com",
    signed = "To:Message-ID:Date:Content-Type:List-Unsubscribe-Post:\r\n\tList-Unsubscribe:From:Subject",
    listUnsubscribe = "<https://01.emailinboundprocessing.eu/enc_user/list_unsubscribe?d=abc%3D%3D\r\n 123>, <mailto:unsub@info.glovoapp.com?subject=Unsubscribe%20me>",
    post = "List-Unsubscribe=One-Click",
    to = "efleming7@me.com",
  } = opts;

  const lines = [
    ...authResults.map((a) => `Authentication-Results: ${a}`),
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${dkimDomain}; s=s2048;\r\n\th=${signed}; bh=abc=; b=def=`,
    `From: ${from}`,
    `To: ${to}`,
    "Subject: Your favourite food is here",
  ];
  if (listUnsubscribe !== null) lines.push(`List-Unsubscribe: ${listUnsubscribe}`);
  if (post !== null) lines.push(`List-Unsubscribe-Post: ${post}`);
  return lines.join("\r\n") + "\r\n\r\nBody: List-Unsubscribe: <https://evil.example/x>\r\n";
}

const GMAIL_DYSON = [
  "Delivered-To: efleming7@gmail.com",
  "Authentication-Results: mx.google.com;",
  "       dkim=pass header.i=@e.dyson.ie header.s=50dkim1 header.b=spnu2iPU;",
  '       dkim=pass header.i=@s50.y.mc.salesforce.com header.s=fbldkim50 header.b="gwo2khQ/";',
  "       spf=pass (google.com: domain of bounce@e.dyson.ie designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@e.dyson.ie",
  "DKIM-Signature: v=1; a=rsa-sha256; d=e.dyson.ie; s=50dkim1;",
  "\th=From:To:Subject:Date:List-Unsubscribe:List-Unsubscribe-Post:MIME-Version; bh=x; b=y",
  "DKIM-Signature: v=1; a=rsa-sha256; d=s50.y.mc.salesforce.com; s=fbldkim50;",
  "\th=From:To:Subject:Date:List-Unsubscribe:List-Unsubscribe-Post:MIME-Version; bh=x; b=y",
  'From: "Dyson" <noreply@e.dyson.ie>',
  "To: efleming7@gmail.com",
  "List-Unsubscribe: <https://click.e.dyson.ie/subscription_center.aspx?jwt=eyJ>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "",
  "<html>...</html>",
].join("\r\n");

// =============================================================================
// Parsing
// =============================================================================

describe("parseHeaders", () => {
  it("unfolds folded lines and lower-cases names", () => {
    const headers = parseHeaders(
      "Subject: Hello\r\n  world\r\nX-Test: 1\r\nX-Test: 2\r\n\r\nBody: no"
    );
    expect(headers.get("subject")).toEqual(["Hello world"]);
    expect(headers.get("x-test")).toEqual(["1", "2"]);
    expect(headers.has("body")).toBe(false);
  });

  it("handles a header block with no body and skips junk lines", () => {
    const headers = parseHeaders(" leading continuation\nnot a header\nFrom: a@b.com");
    expect(headers.get("from")).toEqual(["a@b.com"]);
    expect(headers.size).toBe(1);
  });
});

describe("extractAddress", () => {
  it("extracts bracketed and bare addresses", () => {
    expect(extractAddress('"Glovo" <TokTok@Info.GlovoApp.com>')).toBe("toktok@info.glovoapp.com");
    expect(extractAddress("plain@example.com")).toBe("plain@example.com");
  });

  it("returns null for unparseable values", () => {
    expect(extractAddress("Undisclosed recipients")).toBeNull();
  });
});

describe("parseListUnsubscribe", () => {
  it("splits URIs and strips whitespace inside brackets", () => {
    expect(parseListUnsubscribe("<https://a.example/x? y=1>, <mailto:u@a.example>, <>")).toEqual([
      "https://a.example/x?y=1",
      "mailto:u@a.example",
    ]);
  });
});

describe("parseMailto", () => {
  it("parses address, subject and body", () => {
    expect(parseMailto("mailto:Unsub@List.Example.com?subject=Remove%20me&body=Please")).toEqual({
      address: "unsub@list.example.com",
      subject: "Remove me",
      body: "Please",
    });
  });

  it("defaults subject and body, and strips control characters", () => {
    expect(parseMailto("mailto:u@a.example?subject=%0D%0ABcc:%20x@y.z")).toEqual({
      address: "u@a.example",
      subject: "Bcc: x@y.z",
      body: "unsubscribe",
    });
    expect(parseMailto("mailto:u@a.example")?.subject).toBe("unsubscribe");
  });

  it("rejects invalid or multi-recipient addresses and other schemes", () => {
    expect(parseMailto("mailto:a@b.com,c@d.com")).toBeNull();
    expect(parseMailto("mailto:not-an-address")).toBeNull();
    expect(parseMailto("mailto:%E0%A4%A")).toBeNull();
    expect(parseMailto("https://a.example")).toBeNull();
    expect(parseMailto("::not a url")).toBeNull();
  });
});

describe("isSafeHttpsUrl", () => {
  it("accepts ordinary https URLs", () => {
    expect(isSafeHttpsUrl("https://click.e.dyson.ie/subscription_center.aspx?jwt=1")).toBe(true);
  });

  it.each([
    "http://list.example.com/u",
    "https://localhost/u",
    "https://printer.local/u",
    "https://127.0.0.1/u",
    "https://[::1]/u",
    "https://user:pw@list.example.com/u",
    "https://intranet/u",
    "not a url",
    "https://list.example.com/" + "a".repeat(5000),
  ])("rejects %s", (url) => {
    expect(isSafeHttpsUrl(url)).toBe(false);
  });
});

// =============================================================================
// DKIM
// =============================================================================

describe("passingDkimDomains", () => {
  it("reads header.d (iCloud) and header.i (Gmail) from trusted receivers", () => {
    const domains = passingDkimDomains([
      "dkim-verifier.icloud.com; dkim=pass header.d=Info.GlovoApp.com",
      "mx.google.com; dkim=pass header.i=@e.dyson.ie; dkim=fail header.i=@bad.example; dkim=pass header.s=x",
    ]);
    expect([...domains].sort()).toEqual(["e.dyson.ie", "info.glovoapp.com"]);
  });

  it("ignores results from untrusted authserv-ids", () => {
    expect(passingDkimDomains(["evil.example; dkim=pass header.d=bank.com"]).size).toBe(0);
    expect(passingDkimDomains(["notmx.google.com; dkim=pass header.d=bank.com"]).size).toBe(0);
  });
});

describe("parseDkimSignature", () => {
  it("parses d= and h= with folding whitespace", () => {
    expect(
      parseDkimSignature("v=1; d=Example.com; h=From : To:\r\n\tList-Unsubscribe; b=x")
    ).toEqual({ domain: "example.com", signed: ["from", "to", "list-unsubscribe"] });
  });

  it("returns null without d= or h=", () => {
    expect(parseDkimSignature("v=1; d=example.com")).toBeNull();
    expect(parseDkimSignature("garbage")).toBeNull();
  });
});

describe("isAligned", () => {
  it("allows equal domains and parent/sub domains", () => {
    expect(isAligned("e.dyson.ie", "e.dyson.ie")).toBe(true);
    expect(isAligned("brand.com", "news.brand.com")).toBe(true);
    expect(isAligned("mail.brand.com", "brand.com")).toBe(true);
  });

  it("rejects unrelated domains, siblings and bare TLDs", () => {
    expect(isAligned("salesforce.com", "e.dyson.ie")).toBe(false);
    expect(isAligned("mail.brand.com", "news.brand.com")).toBe(false);
    expect(isAligned("ie", "e.dyson.ie")).toBe(false);
  });
});

// =============================================================================
// Analysis
// =============================================================================

describe("analyzeUnsubscribe", () => {
  it("offers one-click, mailto and web for a well-formed iCloud message", () => {
    const a = analyzeUnsubscribe(buildHeaders());
    expect(a.methods).toEqual(["one-click", "mailto", "web"]);
    expect(a.ineligible).toEqual([]);
    expect(a.dkim).toEqual({
      verified: true,
      domain: "info.glovoapp.com",
      coversListUnsubscribe: true,
      coversListUnsubscribePost: true,
    });
    expect(a.httpsUrl).toBe(
      "https://01.emailinboundprocessing.eu/enc_user/list_unsubscribe?d=abc%3D%3D123"
    );
    expect(a.mailto?.subject).toBe("Unsubscribe me");
  });

  it("handles a Gmail RAW message with an extra ESP signature", () => {
    const a = analyzeUnsubscribe(GMAIL_DYSON);
    expect(a.methods).toEqual(["one-click", "web"]);
    expect(a.dkim.domain).toBe("e.dyson.ie");
    expect(a.ineligible).toEqual([{ method: "mailto", reason: "no mailto unsubscribe address" }]);
  });

  it("refuses everything when DKIM results come from an untrusted header", () => {
    const a = analyzeUnsubscribe(
      buildHeaders({ authResults: ["attacker.example; dkim=pass header.d=info.glovoapp.com"] })
    );
    expect(a.methods).toEqual([]);
    expect(a.ineligible.every((i) => i.reason.startsWith("no passing DKIM signature"))).toBe(true);
  });

  it("refuses when the passing signature is not aligned with From", () => {
    const a = analyzeUnsubscribe(buildHeaders({ from: "Bank <alerts@mybank.com>" }));
    expect(a.methods).toEqual([]);
    expect(a.ineligible[0].reason).toBe("no passing DKIM signature aligned with mybank.com");
  });

  it("refuses when List-Unsubscribe isn't signed", () => {
    const a = analyzeUnsubscribe(buildHeaders({ signed: "From:To:Subject" }));
    expect(a.methods).toEqual([]);
    expect(a.ineligible[0].reason).toBe("DKIM signature does not cover List-Unsubscribe");
  });

  it("falls back to mailto when List-Unsubscribe-Post isn't signed", () => {
    const a = analyzeUnsubscribe(buildHeaders({ signed: "From:List-Unsubscribe" }));
    expect(a.methods).toEqual(["mailto", "web"]);
    expect(a.ineligible).toEqual([
      { method: "one-click", reason: "DKIM signature does not cover List-Unsubscribe-Post" },
    ]);
  });

  it("falls back when the sender doesn't support one-click", () => {
    const a = analyzeUnsubscribe(buildHeaders({ post: null }));
    expect(a.methods).toEqual(["mailto", "web"]);
    expect(a.ineligible[0].reason).toContain("doesn't support one-click");
  });

  it("offers only mailto when there is no https URL", () => {
    const a = analyzeUnsubscribe(
      buildHeaders({ listUnsubscribe: "<http://insecure.example/u>, <mailto:u@info.glovoapp.com>" })
    );
    expect(a.methods).toEqual(["mailto"]);
    expect(a.ineligible.map((i) => i.reason)).toEqual([
      "no https unsubscribe URL",
      "no https unsubscribe URL",
    ]);
  });

  it("rejects unsafe https URLs and unparseable mailto addresses", () => {
    const a = analyzeUnsubscribe(
      buildHeaders({ listUnsubscribe: "<https://10.0.0.1/u>, <mailto:a@b.com,c@d.com>" })
    );
    expect(a.methods).toEqual([]);
    expect(a.ineligible.map((i) => i.reason)).toEqual([
      "unsubscribe URL failed safety checks",
      "mailto address could not be parsed",
      "unsubscribe URL failed safety checks",
    ]);
  });

  it("reports a missing header or unparseable From", () => {
    expect(analyzeUnsubscribe(buildHeaders({ listUnsubscribe: null })).ineligible[0].reason).toBe(
      "no List-Unsubscribe header"
    );
    expect(analyzeUnsubscribe(buildHeaders({ from: "Nobody" })).ineligible[0].reason).toBe(
      "From address could not be parsed"
    );
    expect(analyzeUnsubscribe("Subject: hi").from).toBeNull();
  });

  it("does not read List-Unsubscribe from the message body", () => {
    const a = analyzeUnsubscribe(buildHeaders({ listUnsubscribe: null }));
    expect(a.httpsUrl).toBeNull();
  });
});

describe("formatUnsubscribeAnalysis", () => {
  it("lists methods, details and reasons", () => {
    const text = formatUnsubscribeAnalysis(analyzeUnsubscribe(buildHeaders()));
    expect(text).toContain("DKIM: pass for info.glovoapp.com");
    expect(text).toContain("Available methods (in order): one-click, mailto, web");
    expect(text).toContain("Mailto: unsub@info.glovoapp.com");
    expect(text).toContain("Web unsubscribe page: https://01.emailinboundprocessing.eu/");
  });

  it("explains when nothing is available", () => {
    const text = formatUnsubscribeAnalysis(analyzeUnsubscribe("Subject: hi"));
    expect(text).toContain("From: (unknown)");
    expect(text).toContain("DKIM: not verified");
    expect(text).toContain("Available methods (in order): none");
    expect(text).toContain("one-click: unavailable — no List-Unsubscribe header");
  });

  it("shows partial DKIM coverage", () => {
    const text = formatUnsubscribeAnalysis(
      analyzeUnsubscribe(buildHeaders({ signed: "From:List-Unsubscribe" }))
    );
    expect(text).toContain("List-Unsubscribe: yes, List-Unsubscribe-Post: no");
  });
});

// =============================================================================
// Actions
// =============================================================================

describe("performOneClickUnsubscribe", () => {
  const url = "https://list.example.com/u?t=1";

  it("POSTs the RFC 8058 body without following redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 202 });
    const result = await performOneClickUnsubscribe(url, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, status: 202 });
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init).toMatchObject({
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  });

  it("treats redirects and errors as failures", async () => {
    const redirect = vi.fn().mockResolvedValue({ status: 302 });
    expect(await performOneClickUnsubscribe(url, redirect as unknown as typeof fetch)).toEqual({
      ok: false,
      status: 302,
      error: "Server responded 302",
    });

    const thrown = vi.fn().mockRejectedValue(new Error("timeout"));
    expect(await performOneClickUnsubscribe(url, thrown as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "timeout",
    });

    const thrownString = vi.fn().mockRejectedValue("boom");
    expect(
      (await performOneClickUnsubscribe(url, thrownString as unknown as typeof fetch)).error
    ).toBe("boom");
  });

  it("refuses unsafe URLs without making a request", async () => {
    const fetchMock = vi.fn();
    const result = await performOneClickUnsubscribe(
      "http://list.example.com/u",
      fetchMock as unknown as typeof fetch
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readRawMessageFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "unsub-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a raw .eml file", () => {
    const path = join(dir, "msg.eml");
    writeFileSync(path, GMAIL_DYSON);
    expect(analyzeUnsubscribe(readRawMessageFile(path)).methods).toContain("one-click");
  });

  it("decodes a JSON file with a base64url raw field", () => {
    const path = join(dir, "msg.json");
    writeFileSync(
      path,
      JSON.stringify({ id: "1", raw: Buffer.from(GMAIL_DYSON).toString("base64url") })
    );
    expect(readRawMessageFile(path)).toBe(GMAIL_DYSON);
  });

  it("rejects bad JSON and JSON without raw", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => readRawMessageFile(bad)).toThrow("could not be parsed");

    const noRaw = join(dir, "noraw.json");
    writeFileSync(noRaw, JSON.stringify({ id: "1" }));
    expect(() => readRawMessageFile(noRaw)).toThrow('no string "raw" field');
  });

  it("rejects relative, missing, directory and out-of-bounds paths", () => {
    expect(() => readRawMessageFile("msg.eml")).toThrow("must be absolute");
    expect(() => readRawMessageFile(join(dir, "missing.eml"))).toThrow("File not found");

    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(() => readRawMessageFile(sub)).toThrow("Not a file");

    expect(() => readRawMessageFile("/etc/hosts")).toThrow("outside allowed directories");

    const link = join(dir, "link.eml");
    symlinkSync("/etc/hosts", link);
    expect(() => readRawMessageFile(link)).toThrow("outside allowed directories");
  });
});

describe("pickSenderAddress", () => {
  it("picks the account address the message was delivered to", () => {
    expect(
      pickSenderAddress(buildHeaders({ to: "Eric <EFleming7@me.com>" }), [
        "efleming7@icloud.com",
        "EFleming7@me.com",
      ])
    ).toBe("efleming7@me.com");
  });

  it("falls back to the first address, or null when there are none", () => {
    expect(pickSenderAddress(buildHeaders({ to: "someone@else.com" }), ["a@icloud.com"])).toBe(
      "a@icloud.com"
    );
    expect(pickSenderAddress(buildHeaders(), [" "])).toBeNull();
  });
});
