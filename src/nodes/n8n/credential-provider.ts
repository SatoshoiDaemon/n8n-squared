import type { CredentialProvider } from '../../execution/graph-engine.ts';

/** Resolve n8n credential references through Squared's encrypted credential store. */
export function createSquaredCredentialProvider(store: {
	getCredential(id: string): Promise<{ id: string; name: string; encryptedValue: string } | null>;
}, vault: {
	open(value: string): unknown;
}): CredentialProvider {
	return async (reference, _credentialType, _node) => {
		if (!reference.id) return null;
		const stored = await store.getCredential(reference.id);
		if (!stored) return null;
		const values = vault.open(stored.encryptedValue);
		if (!isCredentialObject(values)) throw new Error(`Credential ${reference.name} did not contain a JSON object`);
		return values;
	};
}

function isCredentialObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
