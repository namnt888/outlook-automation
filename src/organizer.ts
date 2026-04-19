import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAccessToken } from "./auth.js";
import { classify, type Rule } from "./rules.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const BATCH_SIZE = 50;
const DRY_RUN = process.argv.includes("--dry-run");

interface GraphMessage {
  id: string;
  subject: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  isRead: boolean;
  categories: string[];
}

interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
}

interface LogEntry {
  timestamp: string;
  action: "MOVED" | "DRY-RUN" | "SKIP" | "ERROR";
  messageId: string;
  subject: string;
  from: string;
  rule?: string;
  folder?: string;
  category?: string;
  error?: string;
}

class GraphClient {
  constructor(private token: string) {}

  private async request(method: string, path: string, body?: unknown, retries = 3): Promise<Response> {
    const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && retries > 0) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
      console.warn(`[429] rate-limited, sleeping ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request(method, path, body, retries - 1);
    }
    if (res.status >= 500 && retries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return this.request(method, path, body, retries - 1);
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request("GET", path);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request("POST", path, body);
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request("PATCH", path, body);
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

class FolderResolver {
  private cache = new Map<string, string>();

  constructor(private client: GraphClient) {}

  async resolve(path: string): Promise<string> {
    if (this.cache.has(path)) return this.cache.get(path)!;
    const segments = path.split("/").filter(Boolean);
    let parentId: string | null = null;
    let fullPath = "";
    for (const segment of segments) {
      fullPath = fullPath ? `${fullPath}/${segment}` : segment;
      if (this.cache.has(fullPath)) {
        parentId = this.cache.get(fullPath)!;
        continue;
      }
      const listPath = parentId
        ? `/me/mailFolders/${parentId}/childFolders?$filter=${encodeURIComponent(`displayName eq '${segment.replace(/'/g, "''")}'`)}`
        : `/me/mailFolders?$filter=${encodeURIComponent(`displayName eq '${segment.replace(/'/g, "''")}'`)}`;
      const existing = await this.client.get<{ value: MailFolder[] }>(listPath);
      let id: string;
      if (existing.value && existing.value.length > 0) {
        id = existing.value[0].id;
      } else {
        const createPath = parentId ? `/me/mailFolders/${parentId}/childFolders` : `/me/mailFolders`;
        const created = await this.client.post<MailFolder>(createPath, { displayName: segment });
        id = created.id;
        console.log(`[FOLDER] created ${fullPath}`);
      }
      this.cache.set(fullPath, id);
      parentId = id;
    }
    return parentId!;
  }
}

async function fetchReadMessages(client: GraphClient, limit: number): Promise<GraphMessage[]> {
  const select = "id,subject,from,isRead,categories";
  const path = `/me/mailFolders/Inbox/messages?$filter=isRead eq true&$top=${limit}&$select=${select}&$orderby=receivedDateTime asc`;
  const res = await client.get<{ value: GraphMessage[] }>(path);
  return res.value;
}

async function moveMessage(client: GraphClient, messageId: string, destinationId: string): Promise<void> {
  await client.post(`/me/messages/${messageId}/move`, { destinationId });
}

async function setCategory(client: GraphClient, messageId: string, categories: string[]): Promise<void> {
  await client.patch(`/me/messages/${messageId}`, { categories });
}

function ensureLogsDir(): string {
  const dir = resolve(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRunLog(entries: LogEntry[]): string {
  const dir = ensureLogsDir();
  const date = new Date().toISOString().slice(0, 10);
  const file = resolve(dir, `run-${date}.json`);
  writeFileSync(file, JSON.stringify({ runAt: new Date().toISOString(), dryRun: DRY_RUN, entries }, null, 2));
  return file;
}

async function processMessage(
  client: GraphClient,
  folders: FolderResolver,
  msg: GraphMessage
): Promise<LogEntry> {
  const fromAddr = msg.from?.emailAddress?.address ?? "";
  const subject = msg.subject ?? "";
  const rule: Rule | null = classify(fromAddr, subject);
  const base: LogEntry = {
    timestamp: new Date().toISOString(),
    action: "SKIP",
    messageId: msg.id,
    subject,
    from: fromAddr,
  };
  if (!rule) {
    console.log(`[SKIP] ${subject} (from ${fromAddr}) — no rule matched`);
    return base;
  }
  if (DRY_RUN) {
    console.log(`[DRY-RUN] ${subject} → ${rule.folder} [${rule.category}]`);
    return { ...base, action: "DRY-RUN", rule: rule.id, folder: rule.folder, category: rule.category };
  }
  try {
    const destId = await folders.resolve(rule.folder);
    const existingCats = msg.categories ?? [];
    const nextCats = existingCats.includes(rule.category) ? existingCats : [...existingCats, rule.category];
    await setCategory(client, msg.id, nextCats);
    await moveMessage(client, msg.id, destId);
    console.log(`[MOVED] ${subject} → ${rule.folder} [${rule.category}]`);
    return { ...base, action: "MOVED", rule: rule.id, folder: rule.folder, category: rule.category };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] ${subject}: ${message}`);
    return { ...base, action: "ERROR", rule: rule.id, folder: rule.folder, category: rule.category, error: message };
  }
}

async function main(): Promise<void> {
  console.log(`\n=== Outlook Organizer ===`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  const token = await getAccessToken();
  const client = new GraphClient(token);
  const folders = new FolderResolver(client);
  const messages = await fetchReadMessages(client, BATCH_SIZE);
  console.log(`Fetched ${messages.length} read messages from Inbox`);
  const entries: LogEntry[] = [];
  for (const msg of messages) {
    entries.push(await processMessage(client, folders, msg));
  }
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.action] = (acc[e.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nSummary:`, counts);
  const logFile = writeRunLog(entries);
  console.log(`Log written → ${logFile}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
