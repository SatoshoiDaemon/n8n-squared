import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOrCreateBootstrapCode, removeBootstrapCode } from '../persistence/persistent-secrets.js';
import { RequestError } from '../errors.js';

const scryptAsync = promisify(scrypt);
const PASSWORD_COST = 32_768;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELIZATION = 1;
const PASSWORD_BYTES = 64;
const PASSWORD_MAX_MEMORY = 64 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AdminAuthService {
	constructor({ store, dataDir }) {
		this.store = store;
		this.dataDir = dataDir;
	}

	async initialize() {
		await this.store.deleteExpiredSessions(Date.now());
		const admin = await this.store.getAdmin();
		if (admin) await removeBootstrapCode(this.dataDir);
		else await loadOrCreateBootstrapCode(this.dataDir);
	}

	async status(sessionToken) {
		const admin = await this.store.getAdmin();
		if (!admin) return { setupRequired: true, authenticated: false };
		if (!sessionToken) return { setupRequired: false, authenticated: false };
		const session = await this.store.getSession(hashToken(sessionToken), Date.now());
		return { setupRequired: false, authenticated: Boolean(session) };
	}

	async bootstrap({ code, email, password }) {
		if (await this.store.getAdmin()) throw new RequestError(409, 'Administrator setup is already complete');
		const owner = normalizeNewAdmin({ email, password });
		if (typeof code !== 'string' || code.length > 128) throw new RequestError(403, 'Invalid bootstrap code');
		let expectedCode;
		try {
			expectedCode = await readFile(join(this.dataDir, 'bootstrap-code'), 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') throw new RequestError(403, 'Invalid bootstrap code');
			throw error;
		}
		if (!sameSecret(code, expectedCode)) throw new RequestError(403, 'Invalid bootstrap code');

		const passwordHash = await hashPassword(owner.password);
		const created = await this.store.createAdmin({ email: owner.email, passwordHash });
		if (!created) throw new RequestError(409, 'Administrator setup is already complete');
		await removeBootstrapCode(this.dataDir).catch(() => {});
		return this.createSession(owner.email);
	}

	async login({ email, password }) {
		const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
		const safePassword = typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 512 ? password : '';
		const admin = await this.store.getAdmin();
		if (!admin) {
			await derivePassword(safePassword, Buffer.alloc(16));
			throw new RequestError(401, 'Email or password is incorrect');
		}
		if (!safePassword || normalizedEmail !== admin.email || !(await verifyPassword(safePassword, admin.passwordHash))) {
			if (normalizedEmail !== admin.email) await derivePassword(safePassword, Buffer.alloc(16));
			throw new RequestError(401, 'Email or password is incorrect');
		}
		return this.createSession(admin.email);
	}

	async logout(sessionToken) {
		if (sessionToken) await this.store.deleteSession(hashToken(sessionToken));
	}

	async createSession(email) {
		const sessionToken = randomBytes(32).toString('base64url');
		const expiresAt = Date.now() + SESSION_TTL_MS;
		await this.store.createSession({ tokenHash: hashToken(sessionToken), expiresAt });
		return { sessionToken, email, expiresAt };
	}
}

export function sessionCookie(token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
	return `squared_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
	return 'squared_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}

export function sessionTokenFromRequest(request) {
	const cookie = request.headers.cookie;
	if (!cookie) return null;
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== 'squared_session') continue;
		const token = part.slice(separator + 1).trim();
		return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
	}
	return null;
}

async function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = await derivePassword(password, salt);
	return `scrypt$${PASSWORD_COST}$${PASSWORD_BLOCK_SIZE}$${PASSWORD_PARALLELIZATION}$${salt.toString('base64url')}$${Buffer.from(hash).toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
	const [algorithm, cost, blockSize, parallelization, saltValue, hashValue, extra] = String(encoded).split('$');
	if (
		algorithm !== 'scrypt' || Number(cost) !== PASSWORD_COST || Number(blockSize) !== PASSWORD_BLOCK_SIZE ||
		Number(parallelization) !== PASSWORD_PARALLELIZATION || !saltValue || !hashValue || extra !== undefined
	) return false;
	const salt = Buffer.from(saltValue, 'base64url');
	const expected = Buffer.from(hashValue, 'base64url');
	if (salt.length !== 16 || expected.length !== PASSWORD_BYTES) return false;
	const actual = Buffer.from(await derivePassword(password, salt));
	return timingSafeEqual(actual, expected);
}

async function derivePassword(password, salt) {
	return scryptAsync(password, salt, PASSWORD_BYTES, {
		N: PASSWORD_COST,
		r: PASSWORD_BLOCK_SIZE,
		p: PASSWORD_PARALLELIZATION,
		maxmem: PASSWORD_MAX_MEMORY,
	});
}

function normalizeNewAdmin({ email, password }) {
	const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
	if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
		throw new RequestError(400, 'Enter a valid email address');
	}
	if (typeof password !== 'string' || password.length < 12 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 512) {
		throw new RequestError(400, 'Password must contain 12 to 128 characters');
	}
	return { email: normalizedEmail, password };
}

function hashToken(token) {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameSecret(left, right) {
	const leftHash = createHash('sha256').update(left, 'utf8').digest();
	const rightHash = createHash('sha256').update(right, 'utf8').digest();
	return timingSafeEqual(leftHash, rightHash);
}
