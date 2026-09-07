import { md5 } from './md5';

export type TvuCreds = {
	email: string;
	password: string;
	appKey: string;
	appSecret: string;
};

export type TvuDevice = {
	name?: string;
	id?: string;
	peerId?: string;
	status?: unknown;
	available?: unknown;
	ip?: unknown;
	batteryInfo?: unknown;
	[key: string]: unknown;
};

export class TvuAuthError extends Error {}
export class TvuApiError extends Error {
	code?: string;
}

async function sha512Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildAccessKey(appKey: string, appSecret: string): string {
	const timestamp = Date.now().toString();
	const signature = md5(appSecret + timestamp);
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let requestId = '';
	for (let i = 0; i < 32; i++) requestId += chars.charAt(Math.floor(Math.random() * chars.length));
	return JSON.stringify({ appkey: appKey, timestamp, signature, requestId });
}

// Cached session id per account (email + appKey), so a poll cycle doesn't log in again while a
// previous session is still valid - mirrors the original backend's in-memory SID cache
const sidCache = new Map<string, string>();
function cacheKey({ email, appKey }: TvuCreds): string {
	return `${email}::${appKey}`;
}

function isSessionExpired(data: { errorCode?: string; errorInfo?: string } | null): boolean {
	if (!data || data.errorCode === '0x0') return false;
	const info = (data.errorInfo || '').toLowerCase();
	return info.includes('session') || info.includes('login') || info.includes('token');
}

async function fetchNewSession(creds: TvuCreds): Promise<string> {
	const { email, password, appKey, appSecret } = creds;
	const response = await fetch('https://api.tvunetworks.com/openapi/user/3.0/user/getSession', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'AccessKey': buildAccessKey(appKey, appSecret) },
		body: JSON.stringify({ email, pwd: await sha512Hex(password) }),
	});
	if (!response.ok) throw new Error(`TVU getSession request failed (HTTP ${response.status})`);
	const data = await response.json();
	if (data.errorCode !== '0x0') throw new TvuAuthError(data.errorInfo || 'Login failed');
	const sid = data.result as string;
	sidCache.set(cacheKey(creds), sid);
	return sid;
}

async function getSession(creds: TvuCreds, forceNew = false): Promise<string> {
	if (!forceNew) {
		const cached = sidCache.get(cacheKey(creds));
		if (cached) return cached;
	}
	return fetchNewSession(creds);
}

async function fetchDevicePage(creds: TvuCreds, session: string, pageNum: number, pageSize: number) {
	const response = await fetch('https://api.tvunetworks.com/openapi/device/3.0/device/getDeviceList', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'AccessKey': buildAccessKey(creds.appKey, creds.appSecret),
			'SID': session,
		},
		body: JSON.stringify({ session, pageNum, pageSize }),
	});
	return { status: response.status, data: response.ok ? await response.json() : null };
}

async function fetchDevicePageWithRetry(creds: TvuCreds, pageNum: number, pageSize: number) {
	let session = await getSession(creds);
	const first = await fetchDevicePage(creds, session, pageNum, pageSize);
	let data = (first.status === 401 || first.status === 403) ? null : first.data;
	if (data === null || isSessionExpired(data)) {
		sidCache.delete(cacheKey(creds));
		session = await getSession(creds, true);
		({ data } = await fetchDevicePage(creds, session, pageNum, pageSize));
	}
	if (!data || data.errorCode !== '0x0') {
		const err = new TvuApiError(data?.errorInfo || 'getDeviceList failed');
		err.code = data?.errorCode;
		throw err;
	}
	return data.result as { list?: TvuDevice[]; hasNextPage: boolean; nextPage: number };
}

/** Fetch every device visible to a TVU account, paginating through the full device list */
export async function tvuFetchAllDevices(creds: TvuCreds): Promise<TvuDevice[]> {
	const pageSize = 50;
	let pageNum = 1;
	const devices: TvuDevice[] = [];
	let hasNextPage = true;
	while (hasNextPage) {
		const result = await fetchDevicePageWithRetry(creds, pageNum, pageSize);
		devices.push(...(result.list || []));
		({ hasNextPage, nextPage: pageNum } = result);
	}
	return devices;
}
