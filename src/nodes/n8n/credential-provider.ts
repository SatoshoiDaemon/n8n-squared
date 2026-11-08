import type { CredentialProvider } from '../../execution/graph-engine.ts';

/** Resolve n8n credential references through Squared's encrypted credential store. */
export function createSquaredCredentialProvider(store: {
	getCredential(id: string): Promise<{ id: string; name: string; encryptedValue: string } | null>;
	getCredentialByName?(name: string): Promise<{ id: string; name: string; encryptedValue: string } | null>;
	updateCredential(id: string, encryptedValue: string): Promise<boolean>;
}, vault: {
	open(value: string): unknown;
	seal(value: unknown): string;
}): CredentialProvider {
	const provider: CredentialProvider = async (reference, _credentialType, _node) => {
		const stored = reference.id
			? await store.getCredential(reference.id)
			: await store.getCredentialByName?.(reference.name);
		if (!stored) return null;
		const values = vault.open(stored.encryptedValue);
		if (!isCredentialObject(values)) throw new Error(`Credential ${reference.name} did not contain a JSON object`);
		return values;
	};
	provider.update = async (reference, _credentialType, _node, credentials) => {
		const stored = reference.id ? await store.getCredential(reference.id) : await store.getCredentialByName?.(reference.name);
		if (!stored) throw new Error(`Credential ${reference.name} was not found for update`);
		const updated = await store.updateCredential(stored.id, vault.seal(credentials));
		if (!updated) throw new Error(`Credential ${reference.name} was not found for update`);
	};
	return provider;
}

function isCredentialObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
