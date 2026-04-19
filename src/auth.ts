import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const TENANT = "common";
const DEVICE_CODE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const SCOPES = "Mail.ReadWrite offline_access";
const TOKEN_FILE = resolve(process.cwd(), "token.json");

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

function getClientId(): string {
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) throw new Error("MS_CLIENT_ID env var is required");
  return clientId;
}

async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: clientId, scope: SCOPES });
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Device code request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForToken(clientId: string, deviceCode: string, interval: number, expiresIn: number): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceCode,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
    if (res.ok) return data as TokenResponse;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { wait += 5; continue; }
    throw new Error(`Token poll failed: ${data.error} ${data.error_description ?? ""}`);
  }
  throw new Error("Device code expired before user completed sign-in");
}

function saveToken(tok: TokenResponse): TokenData {
  const data: TokenData = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  return data;
}

function loadTokenFromEnvOrFile(): TokenData | null {
  if (process.env.GRAPH_TOKEN_JSON) {
    try {
      return JSON.parse(process.env.GRAPH_TOKEN_JSON) as TokenData;
    } catch {
      throw new Error("GRAPH_TOKEN_JSON is not valid JSON");
    }
  }
  if (existsSync(TOKEN_FILE)) {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as TokenData;
  }
  return null;
}

async function refreshAccessToken(clientId: string, refreshToken: string): Promise<TokenData> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as TokenResponse;
  const data: TokenData = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? refreshToken,
    expires_at: Date.now() + tok.expires_in * 1000,
  };
  if (!process.env.GRAPH_TOKEN_JSON) writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  return data;
}

export async function getAccessToken(): Promise<string> {
  const clientId = getClientId();
  const existing = loadTokenFromEnvOrFile();
  if (!existing) {
    throw new Error(
      "No token found. Run `npm run auth` locally first, then store token.json as GRAPH_TOKEN_JSON secret."
    );
  }
  if (Date.now() < existing.expires_at - 60_000) return existing.access_token;
  const refreshed = await refreshAccessToken(clientId, existing.refresh_token);
  return refreshed.access_token;
}

export async function runDeviceCodeSetup(): Promise<void> {
  const clientId = getClientId();
  const dc = await requestDeviceCode(clientId);
  console.log("\n=== Outlook Organizer — Device Code Login ===");
  console.log(`1. Mở: ${dc.verification_uri}`);
  console.log(`2. Nhập mã: ${dc.user_code}`);
  console.log(`3. Đăng nhập bằng tài khoản outlook.com của bạn`);
  console.log(`\n(${dc.message})\n`);
  const tok = await pollForToken(clientId, dc.device_code, dc.interval, dc.expires_in);
  const saved = saveToken(tok);
  console.log(`✅ Token đã lưu vào ${TOKEN_FILE}`);
  console.log(`   access_token hết hạn lúc: ${new Date(saved.expires_at).toISOString()}`);
  console.log(`\nTiếp theo: copy toàn bộ nội dung token.json → GitHub Secret GRAPH_TOKEN_JSON`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain && process.argv.includes("--setup")) {
  runDeviceCodeSetup().catch((err) => {
    console.error("Auth setup failed:", err);
    process.exit(1);
  });
}
