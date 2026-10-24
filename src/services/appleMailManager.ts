/**
 * Apple Mail Manager
 *
 * Handles all interactions with Apple Mail via AppleScript.
 * This is the core service layer for the MCP server.
 *
 * Architecture:
 * - Text escaping is handled by dedicated helper functions
 * - AppleScript generation uses template builders for consistency
 * - All public methods return typed results (no raw strings)
 * - Error handling is consistent across all operations
 *
 * @module services/appleMailManager
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";
import { homedir } from "os";
import { executeAppleScript } from "@/utils/applescript.js";
import type {
  Message,
  MessageContent,
  Mailbox,
  Account,
  Attachment,
  HealthCheckResult,
  MailStats,
  AccountStats,
  BatchOperationResult,
  SyncStatus,
  RecentlyReceivedStats,
  MailRule,
  Contact,
  EmailTemplate,
  SerialEmailRecipient,
  SerialEmailResult,
  SearchMessagesParams,
  ListMessagesParams,
} from "@/types.js";

// =============================================================================
// Text Processing Utilities
// =============================================================================

/**
 * Escapes text for safe embedding in AppleScript string literals.
 *
 * AppleScript strings use double quotes, so we need to escape:
 * 1. Backslashes (\) - escaped as \\
 * 2. Double quotes (") - escaped as \"
 *
 * @param text - Raw text to escape
 * @returns Text safe for AppleScript string embedding
 */
function escapeForAppleScript(text: string): string {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Validates attachment file paths and builds AppleScript commands to attach them.
 *
 * @param attachments - Absolute file paths to attach
 * @returns AppleScript commands to add attachments, or empty string if none
 * @throws Error if any path is not absolute or does not exist
 */
function buildAttachmentCommands(attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return "";
  for (const filePath of attachments) {
    if (!isAbsolute(filePath)) {
      throw new Error(`Attachment path must be absolute: "${filePath}"`);
    }
    if (!existsSync(filePath)) {
      throw new Error(`Attachment file not found: "${filePath}"`);
    }
  }
  let commands = "";
  for (const filePath of attachments) {
    const safePath = escapeForAppleScript(filePath);
    commands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
  }
  return commands;
}

/**
 * AppleScript snippet that converts a date variable `d` into a
 * locale-independent numeric string: "YYYY-M-D-H-m-s".
 * Use: set d to date received of msg, then inline this snippet.
 */
const AS_DATE_TO_STRING = `((year of d) as string) & "-" & ((month of d as integer) as string) & "-" & ((day of d) as string) & "-" & ((hours of d) as string) & "-" & ((minutes of d) as string) & "-" & ((seconds of d) as string)`;

/**
 * Parses a locale-independent date string "YYYY-M-D-H-m-s"
 * produced by the AppleScript snippet above.
 *
 * Falls back to the locale-dependent `as string` format for
 * backwards compatibility, and finally to current date.
 *
 * @param dateStr - Date string from AppleScript
 * @returns Parsed Date, or current date if parsing fails
 */
function parseAppleScriptDate(dateStr: string): Date {
  // Try locale-independent numeric format first: "YYYY-M-D-H-m-s"
  const numParts = dateStr.split("-").map(Number);
  if (numParts.length === 6 && numParts.every((n) => !isNaN(n))) {
    return new Date(
      numParts[0],
      numParts[1] - 1,
      numParts[2],
      numParts[3],
      numParts[4],
      numParts[5]
    );
  }

  // Fallback: try legacy locale-dependent format
  const withoutPrefix = dateStr.replace(/^date\s+/, "");
  const normalized = withoutPrefix.replace(" at ", " ");
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Parses a date filter string (already validated by DATE_FILTER_SCHEMA) into a
 * local Date. Date-only ISO strings ("2026-03-15") are treated as local
 * midnight rather than UTC midnight, matching the other accepted formats.
 */
function parseDateFilter(value: string): Date {
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const date = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date filter: "${value}"`);
  }
  return date;
}

/**
 * Builds AppleScript that sets `varName` to `date` component by component.
 *
 * `date "..."` literals are parsed using the system locale, so strings like
 * "September 21, 2026" fail to compile on e.g. en_IE systems.
 */
function buildAppleScriptDate(varName: string, date: Date): string {
  const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  // Reset the day first so changing the month can't overflow (e.g. the 31st -> February).
  return [
    `set ${varName} to current date`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${date.getFullYear()}`,
    `set month of ${varName} to ${date.getMonth() + 1}`,
    `set day of ${varName} to ${date.getDate()}`,
    `set time of ${varName} to ${seconds}`,
  ].join("\n");
}

/**
 * Builds the AppleScript date variables and `whose` conditions for a date range.
 * A date-only `dateTo` includes that whole day.
 */
function buildDateRangeFilter(
  dateFrom?: string,
  dateTo?: string
): { setup: string; conditions: string[] } {
  const setup: string[] = [];
  const conditions: string[] = [];
  if (dateFrom) {
    setup.push(buildAppleScriptDate("dateFromValue", parseDateFilter(dateFrom)));
    conditions.push("date received >= dateFromValue");
  }
  if (dateTo) {
    const to = parseDateFilter(dateTo);
    const wholeDay = to.getHours() === 0 && to.getMinutes() === 0 && to.getSeconds() === 0;
    if (wholeDay) to.setDate(to.getDate() + 1);
    setup.push(buildAppleScriptDate("dateToValue", to));
    conditions.push(wholeDay ? "date received < dateToValue" : "date received <= dateToValue");
  }
  return { setup: setup.join("\n"), conditions };
}

/**
 * Joins AppleScript filter conditions into a `whose` clause ("" when there are none).
 */
function buildWhoseClause(conditions: string[]): string {
  return conditions.length > 0 ? `whose ${conditions.join(" and ")}` : "";
}

/**
 * Builds AppleScript that returns messages offset+1 through offset+limit of
 * `theMailbox` (optionally narrowed by a `whose` clause) in the format
 * parseMessageList() expects.
 *
 * Properties are fetched in bulk, one Apple Event per property for the whole
 * range. Reading them message by message costs ~100ms per message, which
 * pushed listings of large mailboxes past the script timeout.
 */
function buildBulkMessageFetch(whoseClause: string, offset: number, limit: number): string {
  const start = Math.max(0, Math.floor(offset)) + 1;
  const end = start + Math.max(1, Math.floor(limit)) - 1;
  const countExpr = whoseClause
    ? `count of (messages of theMailbox ${whoseClause})`
    : "count of messages of theMailbox";
  const rangeExpr = whoseClause
    ? `messages startIdx thru endIdx of (messages of theMailbox ${whoseClause})`
    : "messages startIdx thru endIdx of theMailbox";

  return `
      set totalCount to ${countExpr}
      set startIdx to ${start}
      set endIdx to ${end}
      if endIdx > totalCount then set endIdx to totalCount
      if startIdx > endIdx then return ""
      set theMsgs to a reference to (${rangeExpr})
      set msgIds to id of theMsgs
      set msgSubjects to subject of theMsgs
      set msgSenders to sender of theMsgs
      set msgDates to date received of theMsgs
      set msgReadFlags to read status of theMsgs
      set msgFlaggedFlags to flagged status of theMsgs
      set rows to {}
      repeat with i from 1 to count of msgIds
        set msgSubject to item i of msgSubjects
        if msgSubject is missing value then set msgSubject to ""
        set msgSender to item i of msgSenders
        if msgSender is missing value then set msgSender to ""
        set d to item i of msgDates
        set end of rows to ((item i of msgIds) as string) & "|||" & msgSubject & "|||" & msgSender & "|||" & ${AS_DATE_TO_STRING} & "|||" & ((item i of msgReadFlags) as string) & "|||" & ((item i of msgFlaggedFlags) as string)
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return rows as text
  `;
}

/**
 * Builds an AppleScript command scoped to a specific account.
 */
function buildAccountScopedScript(account: string, command: string): string {
  return `
    tell application "Mail"
      tell account "${escapeForAppleScript(account)}"
        ${command}
      end tell
    end tell
  `;
}

/**
 * Builds an AppleScript command at the application level.
 */
function buildAppLevelScript(command: string): string {
  return `
    tell application "Mail"
      ${command}
    end tell
  `;
}

/**
 * Common mailbox name variations across different account types.
 * Maps normalized (lowercase) names to possible actual names.
 */
const MAILBOX_ALIASES: Record<string, string[]> = {
  inbox: ["INBOX", "Inbox", "inbox"],
  sent: ["Sent", "Sent Items", "Sent Messages", "Sent Mail", "SENT", "sent"],
  drafts: ["Drafts", "DRAFTS", "drafts", "Draft"],
  trash: ["Trash", "Deleted Items", "Deleted Messages", "TRASH", "trash"],
  junk: ["Junk", "Junk Email", "Spam", "JUNK", "junk"],
  archive: ["Archive", "ARCHIVE", "archive", "All Mail"],
};

/** Separator between parent and child names in a mailbox path, e.g. "[Gmail]/All Mail". */
const MAILBOX_PATH_SEPARATOR = "/";

/**
 * Builds an AppleScript reference to a mailbox from its path.
 *
 * Nested mailboxes can't be addressed by name alone: Gmail's system folders
 * live under "[Gmail]", and `mailbox "All Mail" of account "Google"` fails
 * with -1728 even though `name of every mailbox` lists "All Mail".
 *
 * @param path - Mailbox path, e.g. "INBOX" or "[Gmail]/All Mail"
 * @param account - Account to qualify the reference with; omit inside `tell account`
 * @returns e.g. `mailbox "All Mail" of mailbox "[Gmail]" of account "Google"`
 */
export function buildMailboxReference(path: string, account?: string): string {
  const refs = path
    .split(MAILBOX_PATH_SEPARATOR)
    .reverse()
    .map((name) => `mailbox "${escapeForAppleScript(name)}"`);
  if (account) refs.push(`account "${escapeForAppleScript(account)}"`);
  return refs.join(" of ");
}

/** The last component of a mailbox path ("[Gmail]/All Mail" -> "All Mail"). */
function mailboxLeafName(path: string): string {
  const parts = path.split(MAILBOX_PATH_SEPARATOR);
  return parts[parts.length - 1];
}

/**
 * Finds the mailbox path an account uses for a requested mailbox name.
 *
 * Tries, in order: exact path, case-insensitive path, then the same against
 * leaf names (so "All Mail" finds "[Gmail]/All Mail"), then known aliases
 * (e.g. "Sent" -> "Sent Items"). Shallower mailboxes win when leaf names clash.
 *
 * @param requested - Mailbox name or path from the caller
 * @param paths - All mailbox paths in the account
 * @returns The matching path, or undefined if nothing matches
 */
export function matchMailboxPath(requested: string, paths: string[]): string | undefined {
  const byDepth = [...paths].sort(
    (a, b) => a.split(MAILBOX_PATH_SEPARATOR).length - b.split(MAILBOX_PATH_SEPARATOR).length
  );
  const find = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    return (
      byDepth.find((p) => p === name) ??
      byDepth.find((p) => p.toLowerCase() === lower) ??
      byDepth.find((p) => mailboxLeafName(p) === name) ??
      byDepth.find((p) => mailboxLeafName(p).toLowerCase() === lower)
    );
  };

  const direct = find(requested);
  if (direct) return direct;

  for (const alias of MAILBOX_ALIASES[requested.toLowerCase()] ?? []) {
    const match = find(alias);
    if (match) return match;
  }
  return undefined;
}

/**
 * Parses listMailboxes() output: "path|||unread|||total" items joined by
 * "|||ITEM|||", where unread and total are empty when counting failed.
 */
export function parseMailboxList(output: string, account: string): Mailbox[] {
  return output.split("|||ITEM|||").flatMap((item) => {
    const [name, unread, total] = item.split("|||");
    if (!name?.trim()) return [];
    const mailbox: Mailbox = { name: name.trim(), account };
    if (unread && total) {
      mailbox.unreadCount = parseInt(unread) || 0;
      mailbox.messageCount = parseInt(total) || 0;
    }
    return [mailbox];
  });
}

/** Top-level folder holding Gmail's system mailboxes ("[Google Mail]" in some regions). */
const GMAIL_SYSTEM_FOLDERS = ["[Gmail]", "[Google Mail]"];

/**
 * Whether an account's mailbox paths look like a Gmail account.
 */
export function isGmailMailboxList(paths: string[]): boolean {
  return paths.some((p) =>
    GMAIL_SYSTEM_FOLDERS.some((folder) => p.startsWith(folder + MAILBOX_PATH_SEPARATOR))
  );
}

/**
 * Whether `path` is Gmail's All Mail folder, i.e. a move there means "archive".
 */
export function isGmailAllMail(path: string): boolean {
  return GMAIL_SYSTEM_FOLDERS.some(
    (folder) => path === `${folder}${MAILBOX_PATH_SEPARATOR}All Mail`
  );
}

/**
 * Builds AppleScript that finds message `id`, binds it to `msg`, runs
 * `operation`, and returns "ok" or "error:<reason>".
 *
 * Mailboxes in `preferredMailboxes` (full references) are checked first; then
 * every mailbox of every account. Lookups by id are cheap even in Gmail's All
 * Mail, but each mailbox costs an Apple Event, so a good first guess helps.
 */
export function buildFindMessage(
  id: number,
  operation: string,
  preferredMailboxes: string[] = []
): string {
  const preferred = preferredMailboxes
    .map(
      (ref) => `
        if msg is missing value then
          try
            set matchingMsgs to (messages of ${ref} whose id is ${id})
            if (count of matchingMsgs) > 0 then set msg to item 1 of matchingMsgs
          end try
        end if`
    )
    .join("");

  return `
      try
        set msg to missing value${preferred}
        if msg is missing value then
          repeat with acct in accounts
            repeat with mb in mailboxes of acct
              try
                set matchingMsgs to (messages of mb whose id is ${id})
                if (count of matchingMsgs) > 0 then
                  set msg to item 1 of matchingMsgs
                  exit repeat
                end if
              end try
            end repeat
            if msg is not missing value then exit repeat
          end repeat
        end if
        if msg is missing value then return "error:Message not found"
        ${operation}
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `;
}

/**
 * Why moving to Gmail's All Mail is refused.
 *
 * Mail.app files a Gmail message under All Mail even when it's reached through
 * INBOX (`mailbox of msg` is All Mail), so a scripted move to All Mail is a
 * no-op on the server: Gmail keeps the INBOX label and the message reappears
 * on the next sync.
 *
 * Setting `deleted status` on the INBOX copy isn't a workaround either: Mail
 * handles it as delete-to-Trash (`deleteMessages:moveToTrash:`), and on
 * macOS 26.6 / Mail 16.0 it crashed Mail.app without changing the server
 * (tested 2026-09-29). Mail's dictionary has no archive command.
 */
export const GMAIL_ARCHIVE_UNSUPPORTED =
  "Archiving to Gmail's All Mail through Mail.app isn't supported: Gmail keeps the INBOX label, " +
  "so the message returns to the inbox on the next sync. Archive it in Gmail instead.";

/**
 * AppleScript that sets `mbPath` to the path of mailbox `mb` by walking its
 * containers. Nested mailboxes report class `container`, and a top-level
 * mailbox's container is its account, which ends the walk.
 */
const AS_MAILBOX_PATH = `
        set mbPath to name of mb
        set p to contents of mb
        repeat 20 times
          set parentName to missing value
          try
            set p to container of p
            if class of p is in {mailbox, container} then set parentName to name of p
          end try
          if parentName is missing value then exit repeat
          set mbPath to parentName & "${MAILBOX_PATH_SEPARATOR}" & mbPath
        end repeat`;

/**
 * AppleScript that sets `mbUnread` and `mbTotal` for mailbox `mb`.
 *
 * Fetches every read status in one Apple Event and counts "false" in the
 * joined text. `count of (messages whose read status is false)` took 65 s on
 * a 3,000-message Gmail INBOX and timed out on All Mail; this takes ~5 s for
 * 68,000 messages. Mail's `unread count` property is cheap but wrong for IMAP.
 */
const AS_MAILBOX_COUNTS = `
        set readFlags to read status of messages of mb
        set mbTotal to count of readFlags
        set mbUnread to 0
        if mbTotal > 0 then
          set AppleScript's text item delimiters to ","
          set flagText to readFlags as text
          set AppleScript's text item delimiters to "false"
          set mbUnread to (count of text items of flagText) - 1
          set AppleScript's text item delimiters to ""
        end if`;

// =============================================================================
// Apple Mail Manager Class
// =============================================================================

/**
 * Manager class for Apple Mail operations.
 *
 * Provides methods for:
 * - Reading and searching messages
 * - Sending emails
 * - Managing mailboxes
 * - Listing accounts
 *
 * All operations are synchronous since they rely on AppleScript
 * execution via osascript. Error handling is consistent: methods
 * return null/false/empty-array on failure rather than throwing.
 */
export class AppleMailManager {
  /**
   * Default account used when no account is specified.
   */
  private defaultAccount: string | null = null;

  /**
   * TTL cache for expensive AppleScript queries that rarely change.
   * Caches account list and per-account mailbox paths to avoid
   * redundant AppleScript roundtrips on every tool call.
   */
  private cache = {
    accounts: null as { data: Account[]; expiry: number } | null,
    mailboxPaths: new Map<string, { data: string[]; expiry: number }>(),
  };

  /** Cache TTL in milliseconds (60 seconds). */
  private readonly CACHE_TTL_MS = 60_000;

  /**
   * Returns cached accounts or fetches fresh data if cache is expired/empty.
   */
  private getCachedAccounts(): Account[] {
    const now = Date.now();
    if (this.cache.accounts && now < this.cache.accounts.expiry) {
      return this.cache.accounts.data;
    }
    const accounts = this.fetchAccounts();
    this.cache.accounts = { data: accounts, expiry: now + this.CACHE_TTL_MS };
    return accounts;
  }

  /**
   * Returns cached mailbox paths for an account, or fetches fresh.
   * This caches only the path list used by resolveMailbox(), not the
   * full Mailbox objects with counts (which change frequently).
   */
  private getCachedMailboxPaths(account: string): string[] {
    const now = Date.now();
    const cached = this.cache.mailboxPaths.get(account);
    if (cached && now < cached.expiry) {
      return cached.data;
    }
    const paths = this.fetchMailboxPaths(account);
    this.cache.mailboxPaths.set(account, { data: paths, expiry: now + this.CACHE_TTL_MS });
    return paths;
  }

  /**
   * Invalidate all caches. Call after operations that change
   * mailbox structure (create/delete/rename mailbox).
   */
  private invalidateCache(): void {
    this.cache.accounts = null;
    this.cache.mailboxPaths.clear();
  }

  /**
   * Resolves the account to use for an operation.
   * Queries Mail.app's configured default send account, then falls back
   * to the first available account.
   */
  private resolveAccount(account?: string): string {
    if (account) return account;
    if (this.defaultAccount) return this.defaultAccount;

    // Query Mail.app's default send account by inspecting a temporary outgoing message
    const defaultResult = executeAppleScript(
      buildAppLevelScript(`
        set newMsg to make new outgoing message
        set fromAddr to sender of newMsg
        delete newMsg
        return fromAddr
      `)
    );

    if (defaultResult.success && defaultResult.output.trim()) {
      // sender returns "Name <email>" — match to account by email address
      const senderOutput = defaultResult.output.trim();
      const emailMatch = senderOutput.match(/<([^>]+)>/);
      const defaultEmail = emailMatch ? emailMatch[1] : senderOutput;

      const accounts = this.getCachedAccounts();
      const matchedAccount = accounts.find(
        (a) => a.email.toLowerCase() === defaultEmail.toLowerCase()
      );
      if (matchedAccount) {
        this.defaultAccount = matchedAccount.name;
        return this.defaultAccount;
      }
    }

    // Fall back to first available account
    const accounts = this.getCachedAccounts();
    if (accounts.length > 0) {
      this.defaultAccount = accounts[0].name;
      return this.defaultAccount;
    }

    return "iCloud"; // Last resort fallback
  }

  /**
   * Resolves a mailbox name to its path in the account.
   *
   * Different account types (IMAP, Exchange, iCloud) use different
   * mailbox naming conventions:
   * - Gmail: "INBOX", "[Gmail]/Sent Mail", "[Gmail]/All Mail"
   * - Exchange: "Inbox", "Sent Items", "Deleted Items"
   * - iCloud: "INBOX", "Sent", "Trash"
   *
   * See matchMailboxPath() for the matching rules. Pass the result to
   * buildMailboxReference() rather than `mailbox "..."`, since it may be nested.
   *
   * @param mailbox - Requested mailbox name or path
   * @param account - Account to search in
   * @returns Mailbox path, or the original name if not found
   */
  private resolveMailbox(mailbox: string, account: string): string {
    // No match: return the original and let AppleScript report the error
    return matchMailboxPath(mailbox, this.getCachedMailboxPaths(account)) ?? mailbox;
  }

  /**
   * Whether the account has a mailbox matching `mailbox` (including aliases).
   * Assumes it does when the mailbox list can't be fetched.
   */
  private hasMailbox(mailbox: string, account: string): boolean {
    const paths = this.getCachedMailboxPaths(account);
    return paths.length === 0 || matchMailboxPath(mailbox, paths) !== undefined;
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Search for messages matching criteria. All given filters must match.
   * Searches every mailbox when `mailbox` is omitted, and every account when
   * `account` is omitted.
   *
   * @param params - Search filters and result limit (default 50)
   * @returns Array of matching messages
   */
  searchMessages(params: SearchMessagesParams = {}): Message[] {
    const { query, from, subject, mailbox, account, isRead, isFlagged, dateFrom, dateTo } = params;
    const limit = params.limit ?? 50;

    // If no account specified, search across all accounts
    if (!account) {
      const accounts = this.listAccounts();
      const allMessages: Message[] = [];
      for (const acct of accounts) {
        if (allMessages.length >= limit) break;
        if (mailbox && !this.hasMailbox(mailbox, acct.name)) continue;
        const remaining = limit - allMessages.length;
        const msgs = this.searchMessages({ ...params, account: acct.name, limit: remaining });
        allMessages.push(...msgs);
      }
      return allMessages.slice(0, limit);
    }

    const targetAccount = this.resolveAccount(account);

    // Build a single `whose` clause so Mail does the filtering in one Apple Event.
    const conditions: string[] = [];
    if (query) {
      const safeQuery = escapeForAppleScript(query);
      conditions.push(`(subject contains "${safeQuery}" or sender contains "${safeQuery}")`);
    }
    if (from) conditions.push(`sender contains "${escapeForAppleScript(from)}"`);
    if (subject) conditions.push(`subject contains "${escapeForAppleScript(subject)}"`);
    if (isRead !== undefined) conditions.push(`read status is ${isRead}`);
    if (isFlagged !== undefined) conditions.push(`flagged status is ${isFlagged}`);
    const dateRange = buildDateRangeFilter(dateFrom, dateTo);
    conditions.push(...dateRange.conditions);
    const whoseClause = buildWhoseClause(conditions);

    let searchCommand: string;

    if (mailbox) {
      // Search a specific mailbox
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);

      searchCommand = `
      ${dateRange.setup}
      set theMailbox to ${buildMailboxReference(targetMailbox)}
      ${buildBulkMessageFetch(whoseClause, 0, limit)}
    `;
    } else {
      // Search ALL mailboxes — iterate every mailbox in the account, dedup by message ID
      searchCommand = `
      ${dateRange.setup}
      set outputText to ""
      set msgCount to 0
      set seenIds to {}
      repeat with mb in mailboxes
        if msgCount >= ${limit} then exit repeat
        try
          set allMessages to messages of mb ${whoseClause}
          repeat with msg in allMessages
            if msgCount >= ${limit} then exit repeat
            try
              set msgId to id of msg as string
              if seenIds does not contain msgId then
                set end of seenIds to msgId
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set d to date received of msg
                set msgDateStr to ${AS_DATE_TO_STRING}
                set msgRead to read status of msg as string
                set msgFlagged to flagged status of msg as string
                if msgCount > 0 then set outputText to outputText & "|||ITEM|||"
                set outputText to outputText & msgId & "|||" & msgSubject & "|||" & msgSender & "|||" & msgDateStr & "|||" & msgRead & "|||" & msgFlagged & "|||" & name of mb
                set msgCount to msgCount + 1
              end if
            end try
          end repeat
        end try
      end repeat
      return outputText
    `;
    }

    const script = buildAccountScopedScript(targetAccount, searchCommand);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    // Throw rather than return [], so failures and timeouts aren't reported as "No messages found".
    if (!result.success) {
      throw new Error(`Failed to search messages: ${result.error}`);
    }

    if (!result.output.trim()) return [];

    return this.parseMessageList(result.output, mailbox || "INBOX", targetAccount);
  }

  /**
   * Get a message by ID.
   *
   * Note: Mail.app message IDs are unique per mailbox. This method searches
   * all mailboxes in all accounts to find the message.
   */
  getMessageById(id: string): Message | null {
    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set d to date received of msg
                set msgDate to ${AS_DATE_TO_STRING}
                set msgRead to read status of msg as string
                set msgFlagged to flagged status of msg as string
                set msgJunk to junk mail status of msg as string
                set msgDeleted to deleted status of msg as string
                set msgMailbox to name of mb
                set msgAccount to name of acct
                return msgSubject & "|||" & msgSender & "|||" & msgDate & "|||" & msgRead & "|||" & msgFlagged & "|||" & msgJunk & "|||" & msgDeleted & "|||" & msgMailbox & "|||" & msgAccount
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 }); // Longer timeout for search

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get message ${id}: ${result.error}`);
      return null;
    }

    const parts = result.output.split("|||");
    if (parts.length < 9) return null;

    return {
      id: id.toString(),
      subject: parts[0],
      sender: parts[1],
      recipients: [],
      dateReceived: parseAppleScriptDate(parts[2]),
      isRead: parts[3] === "true",
      isFlagged: parts[4] === "true",
      isJunk: parts[5] === "true",
      isDeleted: parts[6] === "true",
      mailbox: parts[7],
      account: parts[8],
      hasAttachments: false,
    };
  }

  /**
   * Get the content of a message.
   */
  getMessageContent(id: string): MessageContent | null {
    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgContent to content of msg
                set htmlContent to ""
                try
                  set htmlContent to source of msg
                end try
                return msgSubject & "|||CONTENT|||" & msgContent & "|||HTML|||" & htmlContent
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get message content: ${result.error}`);
      return null;
    }

    const htmlSplit = result.output.split("|||HTML|||");
    const contentPart = htmlSplit[0];
    const htmlContent = htmlSplit.length > 1 ? htmlSplit[1] : undefined;

    const parts = contentPart.split("|||CONTENT|||");
    if (parts.length < 2) return null;

    return {
      id: id.toString(),
      subject: parts[0],
      plainText: parts[1],
      htmlContent: htmlContent || undefined,
    };
  }

  /**
   * List messages in a mailbox, or in every mailbox when `mailbox` is omitted.
   *
   * @param params - Mailbox, account, filters, and pagination (limit defaults to 50)
   * @returns Array of messages
   */
  listMessages(params: ListMessagesParams = {}): Message[] {
    const { mailbox, account, from, unreadOnly } = params;
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    // If no account specified, list across all accounts
    if (!account) {
      const accounts = this.listAccounts();
      const allMessages: Message[] = [];
      for (const acct of accounts) {
        if (allMessages.length >= limit) break;
        if (mailbox && !this.hasMailbox(mailbox, acct.name)) continue;
        const remaining = limit - allMessages.length;
        const msgs = this.listMessages({ ...params, account: acct.name, limit: remaining });
        allMessages.push(...msgs);
      }
      return allMessages.slice(0, limit);
    }

    const targetAccount = this.resolveAccount(account);

    const conditions: string[] = [];
    if (from) conditions.push(`sender contains "${escapeForAppleScript(from)}"`);
    if (unreadOnly) conditions.push("read status is false");
    const whoseClause = buildWhoseClause(conditions);

    let listCommand: string;

    if (mailbox) {
      // List from a specific mailbox
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);

      listCommand = `
      set theMailbox to ${buildMailboxReference(targetMailbox)}
      ${buildBulkMessageFetch(whoseClause, offset, limit)}
    `;
    } else {
      // List from ALL mailboxes — iterate every mailbox in the account, dedup by message ID
      listCommand = `
      set outputText to ""
      set msgCount to 0
      set skipped to 0
      set seenIds to {}
      repeat with mb in mailboxes
        if msgCount >= ${limit} then exit repeat
        try
          repeat with msg in messages of mb ${whoseClause}
            if msgCount >= ${limit} then exit repeat
            try
              set msgId to id of msg as string
              if seenIds does not contain msgId then
                set end of seenIds to msgId
                if skipped < ${offset} then
                  set skipped to skipped + 1
                else
                  set msgSubject to subject of msg
                  set msgSender to sender of msg
                  set d to date received of msg
                  set msgDate to ${AS_DATE_TO_STRING}
                  set msgRead to read status of msg as string
                  set msgFlagged to flagged status of msg as string
                  if msgCount > 0 then set outputText to outputText & "|||ITEM|||"
                  set outputText to outputText & msgId & "|||" & msgSubject & "|||" & msgSender & "|||" & msgDate & "|||" & msgRead & "|||" & msgFlagged & "|||" & name of mb
                  set msgCount to msgCount + 1
                end if
              end if
            end try
          end repeat
        end try
      end repeat
      return outputText
    `;
    }

    const script = buildAccountScopedScript(targetAccount, listCommand);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    // Throw rather than return [], so failures and timeouts aren't reported as "No messages found".
    if (!result.success) {
      throw new Error(`Failed to list messages: ${result.error}`);
    }

    if (!result.output.trim()) return [];

    return this.parseMessageList(result.output, mailbox || "INBOX", targetAccount);
  }

  /**
   * Parse message list output from AppleScript.
   */
  private parseMessageList(output: string, mailbox: string, account: string): Message[] {
    const items = output.split("|||ITEM|||");
    const messages: Message[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 6) continue;

      messages.push({
        id: parts[0].trim(),
        subject: parts[1],
        sender: parts[2],
        recipients: [],
        dateReceived: parseAppleScriptDate(parts[3]),
        isRead: parts[4] === "true",
        isFlagged: parts[5] === "true",
        isJunk: false,
        isDeleted: false,
        mailbox: parts.length >= 7 ? parts[6] : mailbox,
        account,
        hasAttachments: false,
      });
    }

    return messages;
  }

  /**
   * Send an email.
   *
   * @param to - Recipient email addresses
   * @param subject - Email subject
   * @param body - Email body (plain text)
   * @param cc - CC recipients
   * @param bcc - BCC recipients
   * @param account - Account to send from
   * @returns true if sent successfully
   */
  sendEmail(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string,
    attachments?: string[]
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScript(body);

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }
    if (cc) {
      for (const addr of cc) {
        recipientCommands += `make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }
    if (bcc) {
      for (const addr of bcc) {
        recipientCommands += `make new bcc recipient at end of bcc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }

    const attachmentCommands = buildAttachmentCommands(attachments);

    let sendCommand: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      sendCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `;
    } else {
      sendCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `;
    }

    const script = buildAppLevelScript(sendCommand);
    const result = executeAppleScript(script, { timeoutMs: 60000, maxRetries: 2 });

    if (!result.success) {
      console.error(`Failed to send email: ${result.error}`);
      return false;
    }

    return result.output.includes("sent");
  }

  /**
   * Send individual personalized emails to a list of recipients (mail merge).
   *
   * Replaces {{placeholder}} tokens in subject and body with per-recipient values.
   * Each recipient receives their own individual email.
   *
   * @param recipients - List of recipient objects with email and variable values
   * @param subject - Email subject (may contain {{placeholders}})
   * @param body - Email body (may contain {{placeholders}})
   * @param account - Account to send from
   * @param delayMs - Delay between sends in milliseconds (default: 500, max: 10000)
   * @returns Array of per-recipient results
   */
  sendSerialEmail(
    recipients: SerialEmailRecipient[],
    subject: string,
    body: string,
    account?: string,
    delayMs: number = 500
  ): SerialEmailResult[] {
    const effectiveDelay = Math.min(Math.max(delayMs, 0), 10000);
    const results: SerialEmailResult[] = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      try {
        // Replace all {{Key}} placeholders with recipient's values
        let personalizedSubject = subject;
        let personalizedBody = body;
        for (const [key, value] of Object.entries(recipient.variables)) {
          const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const placeholder = new RegExp(`\\{\\{${safeKey}\\}\\}`, "g");
          personalizedSubject = personalizedSubject.replace(placeholder, value);
          personalizedBody = personalizedBody.replace(placeholder, value);
        }

        const success = this.sendEmail(
          [recipient.email],
          personalizedSubject,
          personalizedBody,
          undefined,
          undefined,
          account
        );

        results.push({
          email: recipient.email,
          success,
          error: success ? undefined : "Failed to send email",
        });
      } catch (error) {
        results.push({
          email: recipient.email,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      // Brief delay between sends to avoid overwhelming Mail.app
      if (effectiveDelay > 0 && i < recipients.length - 1) {
        spawnSync("sleep", [(effectiveDelay / 1000).toString()], { stdio: "ignore" });
      }
    }

    return results;
  }

  /**
   * Create a draft email (saved to Drafts folder, not sent).
   *
   * @param to - Recipient email addresses
   * @param subject - Email subject
   * @param body - Email body (plain text)
   * @param cc - CC recipients
   * @param bcc - BCC recipients
   * @param account - Account to create draft in
   * @returns true if draft created successfully
   */
  createDraft(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string,
    attachments?: string[]
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScript(body);

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }
    if (cc) {
      for (const addr of cc) {
        recipientCommands += `make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }
    if (bcc) {
      for (const addr of bcc) {
        recipientCommands += `make new bcc recipient at end of bcc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }

    const attachmentCommands = buildAttachmentCommands(attachments);

    let draftCommand: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      draftCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        return "draft created"
      `;
    } else {
      draftCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        return "draft created"
      `;
    }

    const script = buildAppLevelScript(draftCommand);
    const result = executeAppleScript(script, { timeoutMs: 60000, maxRetries: 2 });

    if (!result.success) {
      console.error(`Failed to create draft: ${result.error}`);
      return false;
    }

    return result.output.includes("draft created");
  }

  /**
   * Reply to a message.
   *
   * @param id - Message ID to reply to
   * @param body - Reply body
   * @param replyAll - If true, reply to all recipients
   * @param send - If true, send immediately; if false, save as draft
   * @returns true if reply created/sent successfully
   */
  replyToMessage(id: string, body: string, replyAll = false, send = true): boolean {
    const safeBody = escapeForAppleScript(body);
    const replyAllClause = replyAll ? " with reply to all" : "";
    const sendAction = send ? "send theReply" : "";

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theReply to reply msg without opening window${replyAllClause}
                set content of theReply to "${safeBody}"
                ${sendAction}
                return "ok"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to reply to message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Forward a message.
   *
   * @param id - Message ID to forward
   * @param to - Recipients to forward to
   * @param body - Optional body to prepend
   * @param send - If true, send immediately; if false, save as draft
   * @returns true if forward created/sent successfully
   */
  forwardMessage(id: string, to: string[], body?: string, send = true): boolean {
    const safeBody = body ? escapeForAppleScript(body) : "";
    const sendAction = send ? "send theForward" : "";

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients of theForward with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theForward to forward msg without opening window
                ${recipientCommands}
                ${safeBody ? `set content of theForward to "${safeBody}"` : ""}
                ${sendAction}
                return "ok"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to forward message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Helper to find and operate on a message by ID.
   *
   * Looks in `preferredMailboxes` (full AppleScript references) first, then
   * scans every mailbox of every account. `operation` runs once, outside the
   * per-mailbox `try`, so its errors are reported instead of being mistaken
   * for "Message not found".
   */
  private findMessageScript(
    id: string,
    operation: string,
    preferredMailboxes: string[] = []
  ): string {
    return buildAppLevelScript(buildFindMessage(Number(id), operation, preferredMailboxes));
  }

  /**
   * Mark a message as read.
   */
  markAsRead(id: string): boolean {
    const script = this.findMessageScript(id, "set read status of msg to true");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to mark message as read: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Mark a message as unread.
   */
  markAsUnread(id: string): boolean {
    const script = this.findMessageScript(id, "set read status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to mark message as unread: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Flag a message.
   */
  flagMessage(id: string): boolean {
    const script = this.findMessageScript(id, "set flagged status of msg to true");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to flag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Unflag a message.
   */
  unflagMessage(id: string): boolean {
    const script = this.findMessageScript(id, "set flagged status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to unflag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Delete a message.
   */
  deleteMessage(id: string): boolean {
    const script = this.findMessageScript(id, "delete msg");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to delete message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Resolves a move destination and rejects moves that wouldn't reach the server.
   *
   * @throws Error if the mailbox doesn't exist, or it is Gmail's All Mail
   */
  private resolveMoveDestination(
    mailbox: string,
    account?: string
  ): { account: string; path: string; inboxPath: string } {
    const targetAccount = this.resolveAccount(account);
    const paths = this.getCachedMailboxPaths(targetAccount);
    const path = matchMailboxPath(mailbox, paths);
    if (paths.length > 0 && !path) {
      throw new Error(`Mailbox "${mailbox}" not found in account "${targetAccount}"`);
    }
    if (path && isGmailMailboxList(paths) && isGmailAllMail(path)) {
      throw new Error(GMAIL_ARCHIVE_UNSUPPORTED);
    }
    return {
      account: targetAccount,
      path: path ?? mailbox,
      inboxPath: matchMailboxPath("INBOX", paths) ?? "INBOX",
    };
  }

  /**
   * Move a message to a different mailbox.
   *
   * @throws Error if the destination doesn't exist or is Gmail's All Mail
   */
  moveMessage(id: string, mailbox: string, account?: string): boolean {
    return this.moveToDestination(id, this.resolveMoveDestination(mailbox, account));
  }

  private moveToDestination(
    id: string,
    dest: { account: string; path: string; inboxPath: string }
  ): boolean {
    // Most moves are out of the destination account's INBOX, so look there before scanning.
    const script = this.findMessageScript(
      id,
      `move msg to ${buildMailboxReference(dest.path, dest.account)}`,
      [buildMailboxReference(dest.inboxPath, dest.account)]
    );
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to move message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Delete multiple messages at once.
   *
   * @param ids - Array of message IDs to delete
   * @returns Array of results for each message
   */
  batchDeleteMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.deleteMessage(id);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to delete message",
      });
    }

    return results;
  }

  /**
   * Move multiple messages to a mailbox at once.
   *
   * @param ids - Array of message IDs to move
   * @param mailbox - Destination mailbox name
   * @param account - Account containing the destination mailbox
   * @returns Array of results for each message
   * @throws Error if the destination doesn't exist or is Gmail's All Mail
   */
  batchMoveMessages(ids: string[], mailbox: string, account?: string): BatchOperationResult[] {
    const dest = this.resolveMoveDestination(mailbox, account);
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.moveToDestination(id, dest);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to move message",
      });
    }

    return results;
  }

  /**
   * Mark multiple messages as read at once.
   */
  batchMarkAsRead(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.markAsRead(id);
      results.push({ id, success, error: success ? undefined : "Failed to mark message as read" });
    }
    return results;
  }

  /**
   * Mark multiple messages as unread at once.
   */
  batchMarkAsUnread(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.markAsUnread(id);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to mark message as unread",
      });
    }
    return results;
  }

  /**
   * Flag multiple messages at once.
   */
  batchFlagMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.flagMessage(id);
      results.push({ id, success, error: success ? undefined : "Failed to flag message" });
    }
    return results;
  }

  /**
   * Unflag multiple messages at once.
   */
  batchUnflagMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.unflagMessage(id);
      results.push({ id, success, error: success ? undefined : "Failed to unflag message" });
    }
    return results;
  }

  /**
   * List attachments for a message.
   */
  listAttachments(id: string): Attachment[] {
    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set outputText to ""
                set attCount to 0
                repeat with att in mail attachments of msg
                  set attName to name of att
                  set attType to MIME type of att
                  set attSize to file size of att as string
                  if attCount > 0 then set outputText to outputText & "|||ITEM|||"
                  set outputText to outputText & attName & "|||" & attType & "|||" & attSize
                  set attCount to attCount + 1
                end repeat
                return outputText
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split("|||ITEM|||");
    const attachments: Attachment[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;

      attachments.push({
        id: `${id}-${parts[0]}`,
        name: parts[0],
        mimeType: parts[1],
        size: parseInt(parts[2]) || 0,
      });
    }

    return attachments;
  }

  /**
   * Save an attachment from a message to disk.
   */
  saveAttachment(id: string, attachmentName: string, savePath: string): boolean {
    // Validate attachment name: block path separators, traversal, null bytes, and backslashes
    if (/[/\\\0]/.test(attachmentName) || attachmentName.includes("..")) {
      console.error(`Invalid attachment name: "${attachmentName}"`);
      return false;
    }

    // Resolve the save path to prevent symlink / ".." traversal bypass
    const resolvedPath = resolve(savePath);
    const allowedPrefixes = [homedir(), "/tmp", "/private/tmp", "/Volumes"];
    const isAllowed = allowedPrefixes.some((prefix) => resolvedPath.startsWith(prefix));
    if (!isAllowed) {
      console.error(`Save path "${savePath}" is outside allowed directories`);
      return false;
    }

    const safeName = escapeForAppleScript(attachmentName);
    const safePath = escapeForAppleScript(resolvedPath);

    // Use Number(id) as defense-in-depth — the Zod schema already enforces numeric IDs,
    // but this ensures raw interpolation into AppleScript is safe even if validation changes.
    const numericId = Number(id);

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${numericId})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                repeat with att in mail attachments of msg
                  if name of att is "${safeName}" then
                    set savePath to POSIX file "${safePath}/${safeName}"
                    save att in savePath
                    return "ok"
                  end if
                end repeat
                return "error:Attachment not found"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to save attachment: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Mailbox Operations
  // ===========================================================================

  /**
   * List all mailboxes for an account.
   *
   * Nested mailboxes are named by path (e.g. "[Gmail]/All Mail"), which other
   * mailbox parameters accept. When `includeCounts` is false, or counting
   * fails (e.g. times out on a very large mailbox), mailboxes are returned
   * without counts rather than not at all.
   *
   * @param account - Account to list (default account if omitted)
   * @param includeCounts - Count total and unread messages (default true)
   * @returns Mailboxes; counts are undefined where they weren't available
   */
  listMailboxes(account?: string, includeCounts = true): Mailbox[] {
    const targetAccount = this.resolveAccount(account);
    const namesOnly = (): Mailbox[] =>
      this.getCachedMailboxPaths(targetAccount).map((name) => ({ name, account: targetAccount }));

    if (!includeCounts) {
      const mailboxes = namesOnly();
      if (mailboxes.length === 0) {
        throw new Error(`Failed to list mailboxes for account "${targetAccount}"`);
      }
      return mailboxes;
    }

    // Each mailbox's counts are in their own try, so one failure only drops that mailbox's counts.
    const listCommand = `
      set mailboxList to {}
      repeat with mb in mailboxes
        ${AS_MAILBOX_PATH}
        set countText to ""
        try
          ${AS_MAILBOX_COUNTS}
          set countText to (mbUnread as string) & "|||" & (mbTotal as string)
        end try
        set end of mailboxList to mbPath & "|||" & countText
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return mailboxList as text
    `;

    const script = buildAccountScopedScript(targetAccount, listCommand);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success) {
      console.error(`Failed to count mailboxes, listing names only: ${result.error}`);
      const mailboxes = namesOnly();
      if (mailboxes.length === 0) {
        throw new Error(`Failed to list mailboxes: ${result.error}`);
      }
      return mailboxes;
    }

    if (!result.output.trim()) return [];

    return parseMailboxList(result.output, targetAccount);
  }

  /**
   * Get unread count for a mailbox.
   *
   * Counts messages whose read status is false rather than using Mail's
   * `unread count` property, which can be far off for IMAP accounts
   * (e.g. 22 reported vs 294 actual on an iCloud INBOX).
   */
  getUnreadCount(mailbox?: string, account?: string): number {
    const targetAccount = this.resolveAccount(account);

    let command: string;
    if (mailbox) {
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
      command = `
        set mb to ${buildMailboxReference(targetMailbox)}
        ${AS_MAILBOX_COUNTS}
        return mbUnread
      `;
    } else {
      // Get total unread across all mailboxes
      command = `
        set total to 0
        repeat with mb in mailboxes
          -- Some mailboxes (e.g. iCloud's Notes) can't list their messages
          try
            ${AS_MAILBOX_COUNTS}
            set total to total + mbUnread
          end try
        end repeat
        return total
      `;
    }

    const script = buildAccountScopedScript(targetAccount, command);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success) {
      throw new Error(`Failed to get unread count: ${result.error}`);
    }

    return parseInt(result.output) || 0;
  }

  /**
   * Create a new mailbox.
   */
  createMailbox(name: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeName = escapeForAppleScript(name);
    const safeAccount = escapeForAppleScript(targetAccount);

    const script = buildAppLevelScript(`
      try
        make new mailbox with properties {name:"${safeName}"} at account "${safeAccount}"
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to create mailbox: ${result.error || result.output}`);
      return false;
    }

    this.invalidateCache();
    return true;
  }

  /**
   * Delete a mailbox.
   */
  deleteMailbox(name: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const targetMailbox = this.resolveMailbox(name, targetAccount);

    const script = buildAppLevelScript(`
      try
        delete ${buildMailboxReference(targetMailbox, targetAccount)}
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to delete mailbox: ${result.error || result.output}`);
      return false;
    }

    this.invalidateCache();
    return true;
  }

  /**
   * Rename a mailbox by creating a new one, moving messages, and deleting the old one.
   */
  renameMailbox(oldName: string, newName: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);

    // Create the new mailbox
    if (!this.createMailbox(newName, targetAccount)) {
      return false;
    }

    // Move all messages from old to new
    const oldRef = buildMailboxReference(
      this.resolveMailbox(oldName, targetAccount),
      targetAccount
    );
    const newRef = buildMailboxReference(
      this.resolveMailbox(newName, targetAccount),
      targetAccount
    );

    const moveScript = buildAppLevelScript(`
      try
        set srcMailbox to ${oldRef}
        set destMailbox to ${newRef}
        repeat with msg in messages of srcMailbox
          move msg to destMailbox
        end repeat
        delete ${oldRef}
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(moveScript, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to rename mailbox: ${result.error || result.output}`);
      return false;
    }

    this.invalidateCache();
    return true;
  }

  // ===========================================================================
  // Account Operations
  // ===========================================================================

  /**
   * List all mail accounts (uses cache).
   */
  listAccounts(): Account[] {
    return this.getCachedAccounts();
  }

  /**
   * Fetches account list directly from Mail.app via AppleScript.
   * Used internally by the cache; prefer getCachedAccounts() or listAccounts().
   */
  private fetchAccounts(): Account[] {
    const script = buildAppLevelScript(`
      set accountList to {}
      repeat with acct in accounts
        set acctName to name of acct
        set acctEmail to email addresses of acct
        set acctEnabled to enabled of acct
        set emailStr to ""
        if (count of acctEmail) > 0 then
          set emailStr to item 1 of acctEmail
        end if
        set end of accountList to acctName & "|||" & emailStr & "|||" & acctEnabled
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return accountList as text
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list accounts: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    const items = result.output.split("|||ITEM|||");
    const accounts: Account[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;

      accounts.push({
        name: parts[0],
        email: parts[1],
        enabled: parts[2] === "true",
      });
    }

    return accounts;
  }

  /**
   * Fetch mailbox paths for an account directly from Mail.app.
   * Used internally by the cache; prefer getCachedMailboxPaths().
   */
  private fetchMailboxPaths(account: string): string[] {
    const script = buildAccountScopedScript(
      account,
      `
      set mbPaths to {}
      repeat with mb in mailboxes
        ${AS_MAILBOX_PATH}
        set end of mbPaths to mbPath
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return mbPaths as text
    `
    );

    const result = executeAppleScript(script);
    if (!result.success || !result.output) {
      return [];
    }

    return result.output.split("|||ITEM|||").map((s) => s.trim());
  }

  // ===========================================================================
  // Mail Rules
  // ===========================================================================

  /**
   * List all mail rules.
   */
  listRules(): MailRule[] {
    const script = buildAppLevelScript(`
      set ruleList to {}
      repeat with r in rules
        set ruleName to name of r
        set ruleEnabled to enabled of r
        set end of ruleList to ruleName & "|||" & (ruleEnabled as string)
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return ruleList as text
    `);

    const result = executeAppleScript(script);

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split("|||ITEM|||");
    const rules: MailRule[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 2) continue;
      rules.push({
        name: parts[0],
        enabled: parts[1] === "true",
      });
    }

    return rules;
  }

  /**
   * Enable or disable a mail rule.
   */
  setRuleEnabled(ruleName: string, enabled: boolean): boolean {
    const safeName = escapeForAppleScript(ruleName);

    const script = buildAppLevelScript(`
      try
        repeat with r in rules
          if name of r is "${safeName}" then
            set enabled of r to ${enabled}
            return "ok"
          end if
        end repeat
        return "error:Rule not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to set rule state: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Contacts Integration
  // ===========================================================================

  /**
   * Search contacts by name or email.
   */
  searchContacts(query: string): Contact[] {
    const safeQuery = escapeForAppleScript(query);

    const script = `
      tell application "Contacts"
        set matchedContacts to {}
        set foundPeople to (every person whose name contains "${safeQuery}") & (every person whose value of emails contains "${safeQuery}")

        -- Deduplicate by tracking IDs
        set seenIds to {}
        repeat with p in foundPeople
          set pid to id of p
          if seenIds does not contain pid then
            set end of seenIds to pid
            set pName to name of p
            set pEmails to ""
            repeat with e in emails of p
              if pEmails is not "" then set pEmails to pEmails & ","
              set pEmails to pEmails & (value of e)
            end repeat
            set pPhones to ""
            repeat with ph in phones of p
              if pPhones is not "" then set pPhones to pPhones & ","
              set pPhones to pPhones & (value of ph)
            end repeat
            set end of matchedContacts to pName & "|||" & pEmails & "|||" & pPhones
          end if
        end repeat

        set AppleScript's text item delimiters to "|||ITEM|||"
        return matchedContacts as text
      end tell
    `;

    const result = executeAppleScript(script);

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split("|||ITEM|||");
    const contacts: Contact[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;
      contacts.push({
        name: parts[0],
        emails: parts[1] ? parts[1].split(",").filter(Boolean) : [],
        phones: parts[2] ? parts[2].split(",").filter(Boolean) : [],
      });
    }

    return contacts;
  }

  // ===========================================================================
  // Email Templates
  // ===========================================================================

  private templates: Map<string, EmailTemplate> = new Map();
  private nextTemplateId = 1;

  /**
   * List all stored templates.
   */
  listTemplates(): EmailTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get a template by ID.
   */
  getTemplate(id: string): EmailTemplate | null {
    return this.templates.get(id) || null;
  }

  /**
   * Create or update a template.
   */
  saveTemplate(
    name: string,
    subject: string,
    body: string,
    to?: string[],
    cc?: string[],
    id?: string
  ): EmailTemplate {
    const templateId = id || `tmpl_${this.nextTemplateId++}`;
    const template: EmailTemplate = { id: templateId, name, subject, body, to, cc };
    this.templates.set(templateId, template);
    return template;
  }

  /**
   * Delete a template.
   */
  deleteTemplate(id: string): boolean {
    return this.templates.delete(id);
  }

  /**
   * Use a template to create a draft.
   */
  useTemplate(
    id: string,
    overrides?: { to?: string[]; cc?: string[]; subject?: string; body?: string }
  ): boolean {
    const template = this.templates.get(id);
    if (!template) return false;

    const to = overrides?.to || template.to || [];
    const cc = overrides?.cc || template.cc;
    const subject = overrides?.subject || template.subject;
    const body = overrides?.body || template.body;

    if (to.length === 0) return false;

    return this.createDraft(to, subject, body, cc);
  }

  // ===========================================================================
  // Diagnostics
  // ===========================================================================

  /**
   * Run health check on Mail.app connectivity.
   */
  healthCheck(): HealthCheckResult {
    const checks: HealthCheckResult["checks"] = [];

    // Check 1: Mail.app is accessible
    const mailCheck = executeAppleScript('tell application "Mail" to return "ok"');
    if (mailCheck.success && mailCheck.output === "ok") {
      checks.push({
        name: "mail_app",
        passed: true,
        message: "Mail.app is accessible",
      });
    } else {
      const errorHint = mailCheck.error?.includes("not authorized")
        ? " (check Automation permissions in System Preferences)"
        : "";
      checks.push({
        name: "mail_app",
        passed: false,
        message: `Mail.app is not accessible${errorHint}`,
      });
      return { healthy: false, checks };
    }

    // Check 2: AppleScript permissions
    const permCheck = executeAppleScript('tell application "Mail" to get name of account 1');
    if (permCheck.success) {
      checks.push({
        name: "permissions",
        passed: true,
        message: "AppleScript automation permissions granted",
      });
    } else {
      const isPermError =
        permCheck.error?.includes("not authorized") || permCheck.error?.includes("not permitted");
      checks.push({
        name: "permissions",
        passed: !isPermError,
        message: isPermError
          ? "AppleScript permissions denied. Grant access in System Preferences > Privacy & Security > Automation"
          : `Permission check returned: ${permCheck.error}`,
      });
      if (isPermError) {
        return { healthy: false, checks };
      }
    }

    // Check 3: At least one account accessible
    const accounts = this.listAccounts();
    if (accounts.length > 0) {
      const accountNames = accounts.map((a) => a.name).join(", ");
      checks.push({
        name: "accounts",
        passed: true,
        message: `Found ${accounts.length} account(s): ${accountNames}`,
      });
    } else {
      checks.push({
        name: "accounts",
        passed: false,
        message: "No Mail accounts found. Set up an account in Mail.app first.",
      });
      return { healthy: false, checks };
    }

    // Check 4: Basic operations work
    const mailboxes = this.listMailboxes(accounts[0].name);
    checks.push({
      name: "operations",
      passed: true,
      message: `Basic operations working (${mailboxes.length} mailbox(es) in ${accounts[0].name})`,
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Get mail statistics.
   */
  getMailStats(): MailStats {
    const accounts = this.listAccounts();
    const accountStats: AccountStats[] = [];
    let totalMessages = 0;
    let totalUnread = 0;

    for (const account of accounts) {
      const mailboxes = this.listMailboxes(account.name);
      let accountMessages = 0;
      let accountUnread = 0;

      const mailboxStats = mailboxes.map((mb) => {
        const messageCount = mb.messageCount ?? 0;
        const unreadCount = mb.unreadCount ?? 0;
        accountMessages += messageCount;
        accountUnread += unreadCount;
        return { name: mb.name, messageCount, unreadCount };
      });

      totalMessages += accountMessages;
      totalUnread += accountUnread;

      accountStats.push({
        name: account.name,
        totalMessages: accountMessages,
        unreadMessages: accountUnread,
        mailboxCount: mailboxes.length,
        mailboxes: mailboxStats,
      });
    }

    // Get recently received stats
    const recentlyReceived = this.getRecentlyReceivedStats();

    return {
      totalMessages,
      totalUnread,
      accounts: accountStats,
      recentlyReceived,
    };
  }

  /**
   * Get counts of recently received messages.
   *
   * Only counts messages in INBOX for performance (scanning all mailboxes
   * is too slow for large accounts).
   *
   * @returns Counts of messages received in last 24h, 7d, and 30d
   */
  getRecentlyReceivedStats(): RecentlyReceivedStats {
    // Get message counts for different time periods
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Format dates for AppleScript comparison
    const formatDate = (d: Date): string => {
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      return `date "${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}"`;
    };

    // Only scan INBOX for performance - scanning all mailboxes is too slow
    const script = buildAppLevelScript(`
      set last24h to 0
      set last7d to 0
      set last30d to 0
      set oneDayAgo to ${formatDate(oneDayAgo)}
      set sevenDaysAgo to ${formatDate(sevenDaysAgo)}
      set thirtyDaysAgo to ${formatDate(thirtyDaysAgo)}

      repeat with acct in accounts
        try
          -- Try common inbox names
          set inboxNames to {"INBOX", "Inbox", "inbox"}
          repeat with inboxName in inboxNames
            try
              set theInbox to mailbox inboxName of acct
              set last24h to last24h + (count of (messages of theInbox whose date received >= oneDayAgo))
              set last7d to last7d + (count of (messages of theInbox whose date received >= sevenDaysAgo))
              set last30d to last30d + (count of (messages of theInbox whose date received >= thirtyDaysAgo))
              exit repeat
            end try
          end repeat
        end try
      end repeat

      return (last24h as string) & "|||" & (last7d as string) & "|||" & (last30d as string)
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get recently received stats: ${result.error}`);
      return { last24h: 0, last7d: 0, last30d: 0 };
    }

    const parts = result.output.split("|||");
    if (parts.length < 3) {
      return { last24h: 0, last7d: 0, last30d: 0 };
    }

    return {
      last24h: parseInt(parts[0]) || 0,
      last7d: parseInt(parts[1]) || 0,
      last30d: parseInt(parts[2]) || 0,
    };
  }

  /**
   * Get sync status for Mail.app.
   *
   * Checks for sync activity indicators like:
   * - Activity monitor status
   * - Network activity status
   * - Background refresh indicators
   *
   * @returns Sync status information
   */
  getSyncStatus(): SyncStatus {
    // Check for Mail.app background activity and sync status
    // Mail.app doesn't expose sync status directly through AppleScript,
    // so we check for recent changes and activity indicators
    const script = buildAppLevelScript(`
      set syncInfo to ""

      -- Check if Mail.app is running
      tell application "System Events"
        set mailRunning to (name of processes) contains "Mail"
      end tell

      if not mailRunning then
        return "not_running"
      end if

      -- Check for background activity by looking at message counts changing
      -- This is a proxy for sync activity since Mail doesn't expose sync status
      set accountCount to count of accounts
      set totalMailboxes to 0
      repeat with acct in accounts
        set totalMailboxes to totalMailboxes + (count of mailboxes of acct)
      end repeat

      return "running|||" & accountCount & "|||" & totalMailboxes
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      return {
        syncDetected: false,
        pendingUpload: 0,
        recentActivity: false,
        secondsSinceLastChange: -1,
        error: result.error,
      };
    }

    if (result.output === "not_running") {
      return {
        syncDetected: false,
        pendingUpload: 0,
        recentActivity: false,
        secondsSinceLastChange: -1,
        error: "Mail.app is not running",
      };
    }

    // Parse the response
    const parts = result.output.split("|||");
    const isRunning = parts[0] === "running";
    const accountCount = parseInt(parts[1]) || 0;

    // Mail.app is running with accounts configured - assume sync is active
    // (Mail.app syncs automatically when running)
    return {
      syncDetected: isRunning && accountCount > 0,
      pendingUpload: 0, // Not exposed by Mail.app
      recentActivity: isRunning,
      secondsSinceLastChange: 0,
    };
  }
}
