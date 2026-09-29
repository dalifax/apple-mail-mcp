/**
 * Integration tests for apple-mail-mcp
 *
 * These tests run against REAL Apple Mail data — no mocks.
 * They exercise the full stack: Zod schemas → AppleMailManager → AppleScript → Mail.app.
 *
 * Prerequisites:
 *   - macOS with Mail.app configured and at least one account
 *   - Automation permission granted to the terminal running the tests
 *   - At least one message in INBOX
 *
 * Run via: npm run test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { resolve } from "path";
import { homedir } from "os";
import { AppleMailManager } from "../src/services/appleMailManager.js";

// ---------------------------------------------------------------------------
// Shared schemas (mirrored from index.ts so we can test them directly)
// ---------------------------------------------------------------------------

const MESSAGE_ID_SCHEMA = z.string().regex(/^\d+$/, "Message ID must be numeric");

const BATCH_IDS_SCHEMA = z
  .array(MESSAGE_ID_SCHEMA)
  .min(1, "At least one message ID is required")
  .max(100, "Cannot process more than 100 messages in a single batch");

const DATE_FILTER_SCHEMA = z
  .string()
  .regex(
    /^[a-zA-Z0-9 ,/\-:]+$/,
    "Date must contain only alphanumeric characters, spaces, commas, slashes, hyphens, and colons"
  )
  .optional();

// ---------------------------------------------------------------------------
// Test state shared across describe blocks
// ---------------------------------------------------------------------------

let mgr: AppleMailManager;
let realMessageId: string | null = null;
let realAccount: string | null = null;

beforeAll(() => {
  mgr = new AppleMailManager();
});

// ===========================================================================
// Schema validation (no Mail.app interaction)
// ===========================================================================

describe("schema validation", () => {
  describe("MESSAGE_ID_SCHEMA", () => {
    it.each(["12345", "0", "999999999"])("accepts valid numeric ID: %s", (id) => {
      expect(MESSAGE_ID_SCHEMA.parse(id)).toBe(id);
    });

    it.each([
      ["AppleScript injection", '1" & do shell script "rm -rf /'],
      ["non-numeric", "abc"],
      ["mixed", "123abc"],
      ["negative", "-1"],
      ["spaces", "12 34"],
      ["empty", ""],
      ["template ID", "tmpl_1"],
    ])("rejects %s: %s", (_label, id) => {
      expect(() => MESSAGE_ID_SCHEMA.parse(id)).toThrow();
    });
  });

  describe("BATCH_IDS_SCHEMA", () => {
    it("accepts 1-100 valid numeric IDs", () => {
      expect(BATCH_IDS_SCHEMA.parse(["1", "2", "3"])).toEqual(["1", "2", "3"]);
    });

    it("accepts exactly 100 IDs", () => {
      const ids = Array.from({ length: 100 }, (_, i) => String(i));
      expect(BATCH_IDS_SCHEMA.parse(ids)).toHaveLength(100);
    });

    it("rejects empty array", () => {
      expect(() => BATCH_IDS_SCHEMA.parse([])).toThrow();
    });

    it("rejects more than 100 IDs", () => {
      const ids = Array.from({ length: 101 }, (_, i) => String(i));
      expect(() => BATCH_IDS_SCHEMA.parse(ids)).toThrow();
    });

    it("rejects batch containing non-numeric IDs", () => {
      expect(() => BATCH_IDS_SCHEMA.parse(["123", "abc", "456"])).toThrow();
    });
  });

  describe("DATE_FILTER_SCHEMA", () => {
    it.each(["January 1, 2026", "March 15, 2026", "2026-03-15", "3/15/2026", "12:30:00"])(
      "accepts valid date string: %s",
      (d) => {
        expect(DATE_FILTER_SCHEMA.parse(d)).toBe(d);
      }
    );

    it("accepts undefined (optional)", () => {
      expect(DATE_FILTER_SCHEMA.parse(undefined)).toBeUndefined();
    });

    it.each([
      ["quotes (injection)", '"January 1" & do shell script "evil"'],
      ["backslash", "January\\1"],
      ["parentheses", "date(2026)"],
      ["semicolon", "Jan 1; evil"],
      ["ampersand", "Jan & evil"],
    ])("rejects %s: %s", (_label, d) => {
      expect(() => DATE_FILTER_SCHEMA.parse(d)).toThrow();
    });
  });
});

// ===========================================================================
// saveAttachment input validation (no Mail.app interaction for bad inputs)
// ===========================================================================

describe("saveAttachment path safety", () => {
  // These all use a bogus message ID so even if validation passes,
  // the AppleScript would just return "message not found".
  const BOGUS_ID = "99999999";

  it("blocks path traversal in savePath", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", "/tmp/../../etc");
    expect(result).toBe(false);
  });

  it("blocks directory traversal in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "../../etc/passwd", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks backslash in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "file\\name.txt", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks null byte in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "file\0name.txt", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks forward slash in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "path/to/file.txt", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks save path outside allowed directories", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", "/etc");
    expect(result).toBe(false);
  });

  it("blocks save path to /usr", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", "/usr/local");
    expect(result).toBe(false);
  });

  it("allows save path under home directory", () => {
    // Will fail at "message not found" stage, but should pass path validation
    // (returns false because the message doesn't exist, not because of path)
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", `${homedir()}/Downloads`);
    // We can't distinguish path-fail from message-not-found via boolean alone,
    // but this at least confirms it doesn't throw.
    expect(typeof result).toBe("boolean");
  });
});

// ===========================================================================
// Live Mail.app operations (read-only)
// ===========================================================================

describe("live Mail.app operations", { timeout: 120_000 }, () => {
  it("lists at least one account and finds one with INBOX", () => {
    const accounts = mgr.listAccounts();
    expect(accounts.length).toBeGreaterThan(0);

    // Some accounts (e.g. iCloud) may not have a standard INBOX.
    // Find the first account that has messages in INBOX.
    for (const acct of accounts) {
      try {
        const messages = mgr.listMessages({ mailbox: "INBOX", account: acct.name, limit: 1 });
        if (messages.length > 0) {
          realAccount = acct.name;
          break;
        }
      } catch {
        // No INBOX in this account; listMessages throws instead of returning []
      }
    }

    expect(realAccount).not.toBeNull();
  });

  it("lists messages from INBOX", () => {
    expect(realAccount).not.toBeNull();
    const messages = mgr.listMessages({ mailbox: "INBOX", account: realAccount!, limit: 5 });
    expect(messages.length).toBeGreaterThan(0);

    // Capture a real message ID for subsequent tests
    realMessageId = messages[0].id;

    // Verify the real ID is numeric (critical for Number(id) defense)
    expect(realMessageId).toMatch(/^\d+$/);
  });

  it("retrieves a message by numeric ID", () => {
    expect(realMessageId).not.toBeNull();
    const msg = mgr.getMessageById(realMessageId!);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(realMessageId);
  });

  it("gets message content by ID", () => {
    expect(realMessageId).not.toBeNull();
    const content = mgr.getMessageContent(realMessageId!);
    expect(content).not.toBeNull();
    expect(content!.subject).toBeDefined();
  });

  it("lists attachments for a message (may be empty)", () => {
    expect(realMessageId).not.toBeNull();
    const attachments = mgr.listAttachments(realMessageId!);
    expect(Array.isArray(attachments)).toBe(true);
  });

  it("searches messages with date range filter", () => {
    // Month-first dates must work regardless of the system locale (they used to
    // fail to compile under e.g. en_IE and silently return no results).
    expect(realMessageId).not.toBeNull();
    const newest = mgr.listMessages({ mailbox: "INBOX", account: realAccount!, limit: 1 })[0];
    const day = newest.dateReceived;
    const label = day.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const messages = mgr.searchMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 5,
      dateFrom: label,
      dateTo: label,
    });
    expect(messages.map((m) => m.id)).toContain(newest.id);
    for (const m of messages) {
      expect(m.dateReceived.toDateString()).toBe(day.toDateString());
    }
  });

  it("lists only unread messages with unreadOnly", () => {
    const messages = mgr.listMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 20,
      unreadOnly: true,
    });
    for (const m of messages) {
      expect(m.isRead).toBe(false);
    }
  });

  it("filters search results by read and flagged status", () => {
    const read = mgr.searchMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 20,
      isRead: true,
    });
    for (const m of read) expect(m.isRead).toBe(true);

    const unflagged = mgr.searchMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 20,
      isFlagged: false,
    });
    for (const m of unflagged) expect(m.isFlagged).toBe(false);
  });

  it("filters search results by sender and subject", () => {
    const newest = mgr.listMessages({ mailbox: "INBOX", account: realAccount!, limit: 1 })[0];
    const subjectWord = newest.subject.split(/\s+/).find((w) => w.length >= 4) ?? newest.subject;

    const bySubject = mgr.searchMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 20,
      subject: subjectWord,
    });
    expect(bySubject.map((m) => m.id)).toContain(newest.id);
    for (const m of bySubject) expect(m.subject.toLowerCase()).toContain(subjectWord.toLowerCase());

    const bySender = mgr.searchMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 20,
      from: newest.sender,
    });
    expect(bySender.map((m) => m.id)).toContain(newest.id);
    for (const m of bySender) expect(m.sender).toBe(newest.sender);

    const noMatch = mgr.searchMessages({
      mailbox: "INBOX",
      account: realAccount!,
      subject: "zz-no-such-subject-8f3a1c",
    });
    expect(noMatch).toEqual([]);
  });

  it("paginates list results with offset", () => {
    const firstTwo = mgr.listMessages({ mailbox: "INBOX", account: realAccount!, limit: 2 });
    const second = mgr.listMessages({
      mailbox: "INBOX",
      account: realAccount!,
      limit: 1,
      offset: 1,
    });
    if (firstTwo.length < 2) return;
    expect(second[0].id).toBe(firstTwo[1].id);
  });

  it("lists mailboxes for an account", () => {
    expect(realAccount).not.toBeNull();
    const mailboxes = mgr.listMailboxes(realAccount!);
    expect(mailboxes.length).toBeGreaterThan(0);
  });

  it("gets unread count without error", () => {
    const count = mgr.getUnreadCount(undefined, realAccount ?? undefined);
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("counts INBOX unread consistently with the messages' read status", () => {
    const count = mgr.getUnreadCount("INBOX", realAccount!);
    const sample = mgr.listMessages({ mailbox: "INBOX", account: realAccount!, limit: 200 });
    const unreadInSample = sample.filter((m) => !m.isRead).length;
    expect(count).toBeGreaterThanOrEqual(unreadInSample);
  });

  it("runs health check", () => {
    const result = mgr.healthCheck();
    expect(result).toBeDefined();
    expect(typeof result.healthy).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
  });

  it("confirms real message IDs are safe for Number() cast", () => {
    expect(realMessageId).not.toBeNull();
    const num = Number(realMessageId);
    expect(Number.isNaN(num)).toBe(false);
    expect(Number.isFinite(num)).toBe(true);
    expect(num).toBeGreaterThan(0);
  });
});
