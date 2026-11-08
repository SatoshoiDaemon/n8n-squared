import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class CredentialVault {
	constructor(secret) {
		this.key = createHash('sha256').update(secret, 'utf8').digest();
	}

	seal(value) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
		return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join('.');
	}

	open(sealed) {
		const [version, ivHex, tagHex, dataHex] = sealed.split('.');
		if (version !== 'v1' || !ivHex || !tagHex || !dataHex) throw new Error('Unsupported credential value');
		const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
		decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
		const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
		return JSON.parse(decrypted.toString('utf8'));
	}
}
