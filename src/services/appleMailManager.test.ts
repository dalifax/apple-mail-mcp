/**
 * Unit tests for mailbox path handling, mailbox listing, and message moves.
 * AppleScript execution is mocked; see test/integration.test.ts for Mail.app.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAppleScript } from "@/utils/applescript.js";
import {
  AppleMailManager,
  buildFindMessage,
  buildMailboxReference,
  GMAIL_ARCHIVE_UNSUPPORTED,
  isGmailAllMail,
  isGmailMailboxList,
  matchMailboxPath,
  parseMailboxList,
} from "./appleMailManager.js";

vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));

const mockExecute = vi.mocked(executeAppleScript);

/** Mailbox paths as Mail.app reports them for a Gmail account. */
const GMAIL_PATHS = [
  "[Gmail]/Important",
  "[Gmail]/Starred",
  "[Gmail]/All Mail",
  "[Gmail]/Drafts",
  "[Gmail]/Sent Mail",
  "[Gmail]/Trash",
  "[Gmail]/Spam",
  "[Gmail]",
  "[Gmail]Trash",
  "Marketing",
  "INBOX",
];

const ICLOUD_PATHS = ["INBOX", "Drafts", "Sent Messages", "Deleted Messages", "Junk", "Archive"];

const ok = (output: string) => ({ success: true, output });
const fail = (error: string) => ({ success: false, output: "", error });

/** Routes mocked AppleScript calls by what the script does. */
function mockMail(handlers: {
  paths?: string[];
  counts?: () => ReturnType<typeof ok>;
  other?: (script: string) => ReturnType<typeof ok>;
}) {
  mockExecute.mockImplementation((script: string) => {
    if (script.includes("set end of mbPaths to mbPath")) {
      return ok((handlers.paths ?? []).join("|||ITEM|||"));
    }
    if (script.includes("set end of mailboxList")) {
      return handlers.counts ? handlers.counts() : fail("unexpected count script");
    }
    return handlers.other ? handlers.other(script) : ok("ok");
  });
}

beforeEach(() => {
  mockExecute.mockReset();
});

describe("buildMailboxReference", () => {
  it("references a top-level mailbox", () => {
    expect(buildMailboxReference("INBOX")).toBe('mailbox "INBOX"');
  });

  it("references a nested mailbox through its parents", () => {
    expect(buildMailboxReference("[Gmail]/All Mail", "Google")).toBe(
      'mailbox "All Mail" of mailbox "[Gmail]" of account "Google"'
    );
  });

  it("escapes quotes and backslashes", () => {
    expect(buildMailboxReference('a"b\\c', 'Acc"t')).toBe(
      'mailbox "a\\"b\\\\c" of account "Acc\\"t"'
    );
  });
});

describe("matchMailboxPath", () => {
  it("matches exact and case-insensitive paths", () => {
    expect(matchMailboxPath("[Gmail]/All Mail", GMAIL_PATHS)).toBe("[Gmail]/All Mail");
    expect(matchMailboxPath("inbox", GMAIL_PATHS)).toBe("INBOX");
  });

  it("matches nested mailboxes by leaf name", () => {
    expect(matchMailboxPath("All Mail", GMAIL_PATHS)).toBe("[Gmail]/All Mail");
    expect(matchMailboxPath("sent mail", GMAIL_PATHS)).toBe("[Gmail]/Sent Mail");
  });

  it("resolves aliases to nested Gmail folders", () => {
    expect(matchMailboxPath("archive", GMAIL_PATHS)).toBe("[Gmail]/All Mail");
    expect(matchMailboxPath("Sent", GMAIL_PATHS)).toBe("[Gmail]/Sent Mail");
    expect(matchMailboxPath("junk", GMAIL_PATHS)).toBe("[Gmail]/Spam");
    expect(matchMailboxPath("trash", GMAIL_PATHS)).toBe("[Gmail]/Trash");
  });

  it("resolves aliases on flat accounts", () => {
    expect(matchMailboxPath("Sent", ICLOUD_PATHS)).toBe("Sent Messages");
    expect(matchMailboxPath("Trash", ICLOUD_PATHS)).toBe("Deleted Messages");
  });

  it("prefers the shallower mailbox when leaf names clash", () => {
    expect(matchMailboxPath("Trash", ["[Gmail]/Trash", "Trash"])).toBe("Trash");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchMailboxPath("Nope", GMAIL_PATHS)).toBeUndefined();
  });
});

describe("Gmail detection", () => {
  it("recognises Gmail by its system folder", () => {
    expect(isGmailMailboxList(GMAIL_PATHS)).toBe(true);
    expect(isGmailMailboxList(["[Google Mail]/All Mail", "INBOX"])).toBe(true);
    expect(isGmailMailboxList(ICLOUD_PATHS)).toBe(false);
  });

  it("recognises All Mail", () => {
    expect(isGmailAllMail("[Gmail]/All Mail")).toBe(true);
    expect(isGmailAllMail("[Google Mail]/All Mail")).toBe(true);
    expect(isGmailAllMail("Archive")).toBe(false);
    expect(isGmailAllMail("[Gmail]/Trash")).toBe(false);
  });
});

describe("parseMailboxList", () => {
  it("parses paths with counts", () => {
    expect(
      parseMailboxList("[Gmail]/All Mail|||1431|||68445|||ITEM|||INBOX|||0|||0", "Google")
    ).toEqual([
      { name: "[Gmail]/All Mail", account: "Google", unreadCount: 1431, messageCount: 68445 },
      { name: "INBOX", account: "Google", unreadCount: 0, messageCount: 0 },
    ]);
  });

  it("leaves counts undefined where counting failed", () => {
    expect(parseMailboxList("Notes|||", "iCloud")).toEqual([{ name: "Notes", account: "iCloud" }]);
  });
});

describe("buildFindMessage", () => {
  it("checks preferred mailboxes before scanning every account", () => {
    const script = buildFindMessage(42, "move msg to x", ['mailbox "INBOX" of account "Google"']);
    const preferredAt = script.indexOf(
      'messages of mailbox "INBOX" of account "Google" whose id is 42'
    );
    const scanAt = script.indexOf("repeat with acct in accounts");
    expect(preferredAt).toBeGreaterThan(-1);
    expect(preferredAt).toBeLessThan(scanAt);
  });

  it("runs the operation once, after the search, so its errors are reported", () => {
    const script = buildFindMessage(42, "move msg to x");
    expect(script.split("move msg to x")).toHaveLength(2);
    expect(script.indexOf("move msg to x")).toBeGreaterThan(
      script.indexOf('if msg is missing value then return "error:Message not found"')
    );
  });
});

describe("AppleMailManager.listMailboxes", () => {
  it("returns names only without running the count script", () => {
    mockMail({ paths: GMAIL_PATHS });
    const mailboxes = new AppleMailManager().listMailboxes("Google", false);
    expect(mailboxes.map((m) => m.name)).toEqual(GMAIL_PATHS);
    expect(mailboxes.every((m) => m.unreadCount === undefined)).toBe(true);
  });

  it("falls back to names when counting times out", () => {
    mockMail({ paths: GMAIL_PATHS, counts: () => fail("Operation timed out after 60 seconds") });
    const mailboxes = new AppleMailManager().listMailboxes("Google");
    expect(mailboxes.map((m) => m.name)).toEqual(GMAIL_PATHS);
  });

  it("throws when neither counts nor names can be fetched", () => {
    mockExecute.mockReturnValue(fail("Mail.app not responding"));
    expect(() => new AppleMailManager().listMailboxes("Google")).toThrow(/Mail.app not responding/);
  });

  it("counts with bulk read status rather than a `whose` query", () => {
    mockMail({ paths: GMAIL_PATHS, counts: () => ok("INBOX|||2|||10") });
    expect(new AppleMailManager().listMailboxes("Google")).toEqual([
      { name: "INBOX", account: "Google", unreadCount: 2, messageCount: 10 },
    ]);
    const countScript = mockExecute.mock.calls
      .map(([script]) => script)
      .find((script) => script.includes("set end of mailboxList"));
    expect(countScript).toContain("read status of messages of mb");
    expect(countScript).not.toContain("whose read status is false");
  });
});

describe("AppleMailManager.moveMessage", () => {
  it("refuses Gmail archive without touching the message", () => {
    mockMail({ paths: GMAIL_PATHS });
    const manager = new AppleMailManager();
    for (const name of ["All Mail", "[Gmail]/All Mail", "archive"]) {
      expect(() => manager.moveMessage("83346", name, "Google")).toThrow(GMAIL_ARCHIVE_UNSUPPORTED);
    }
    expect(mockExecute.mock.calls.some(([script]) => script.includes("move msg"))).toBe(false);
  });

  it("refuses Gmail archive for a whole batch up front", () => {
    mockMail({ paths: GMAIL_PATHS });
    expect(() =>
      new AppleMailManager().batchMoveMessages(["1", "2"], "All Mail", "Google")
    ).toThrow(GMAIL_ARCHIVE_UNSUPPORTED);
  });

  it("still allows Archive on non-Gmail accounts", () => {
    mockMail({ paths: ICLOUD_PATHS });
    expect(new AppleMailManager().moveMessage("7", "archive", "iCloud")).toBe(true);
  });

  it("rejects an unknown destination mailbox", () => {
    mockMail({ paths: GMAIL_PATHS });
    expect(() => new AppleMailManager().moveMessage("7", "Nope", "Google")).toThrow(
      'Mailbox "Nope" not found in account "Google"'
    );
  });

  it("moves to a nested mailbox, looking in the account's INBOX first", () => {
    let moveScript = "";
    mockMail({
      paths: GMAIL_PATHS,
      other: (script) => {
        moveScript = script;
        return ok("ok");
      },
    });
    expect(new AppleMailManager().moveMessage("7", "Spam", "Google")).toBe(true);
    expect(moveScript).toContain(
      'move msg to mailbox "Spam" of mailbox "[Gmail]" of account "Google"'
    );
    expect(moveScript).toContain('messages of mailbox "INBOX" of account "Google" whose id is 7');
  });

  it("reports failure when the script returns an error", () => {
    mockMail({ paths: GMAIL_PATHS, other: () => ok("error:Message not found") });
    expect(new AppleMailManager().moveMessage("7", "Marketing", "Google")).toBe(false);
  });
});
